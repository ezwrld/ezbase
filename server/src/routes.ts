import type { Context } from 'hono'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { sql, ensureCollection, qualifiedTable, clearDatabaseCaches } from './db.js'
import { generateId } from './id.js'
import { publishChange, subscribe } from './pubsub.js'
import { requirePermission } from './middleware.js'

// ── Helpers ───────────────────────────────────────────────────
function formatDoc(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    data: row.data as Record<string, unknown>,
    created: Number(row.created_at),
    updated: Number(row.updated_at),
  }
}

function mapOp(op: string): string {
  const ops: Record<string, string> = {
    '==': '=',
    '!=': '!=',
    '<': '<',
    '>': '>',
    '<=': '<=',
    '>=': '>=',
  }
  return ops[op] || '='
}

function sanitizeField(field: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field)) {
    throw new Error(`Invalid field name: ${field}`)
  }
  return field
}

function buildQuery(
  database: string,
  collection: string,
  whereParam?: string,
  orderBy?: string,
  order?: string,
  limitParam?: string
) {
  let query = `SELECT * FROM db_${database}.col_${collection} WHERE true`
  const params: unknown[] = []

  if (whereParam) {
    const wheres: [string, string, unknown][] = JSON.parse(whereParam)
    for (const [field, op, value] of wheres) {
      const sqlOp = mapOp(op)
      const idx = params.length + 1

      // Map SDK field names to column names
      const colName = field === 'created' ? 'created_at' : field === 'updated' ? 'updated_at' : null

      if (colName) {
        query += ` AND ${colName} ${sqlOp} $${idx}`
      } else if (typeof value === 'number') {
        query += ` AND (data->>'${sanitizeField(field)}')::numeric ${sqlOp} $${idx}`
      } else if (typeof value === 'boolean') {
        query += ` AND (data->>'${sanitizeField(field)}')::boolean ${sqlOp} $${idx}`
      } else {
        query += ` AND data->>'${sanitizeField(field)}' ${sqlOp} $${idx}`
      }
      params.push(value)
    }
  }

  if (orderBy) {
    const dir = (order || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC'
    const colName = orderBy === 'created' ? 'created_at' : orderBy === 'updated' ? 'updated_at' : null
    if (colName) {
      query += ` ORDER BY ${colName} ${dir}`
    } else {
      query += ` ORDER BY data->>'${sanitizeField(orderBy)}' ${dir}`
    }
  } else {
    query += ' ORDER BY created_at DESC'
  }

  if (limitParam) {
    const n = parseInt(limitParam, 10)
    if (n > 0) {
      params.push(n)
      query += ` LIMIT $${params.length}`
    }
  }

  return { query, params }
}

// ── Collection routes factory ────────────────────────────────
function collectionRoutes(getDatabase: (c: Context) => string) {
  const app = new Hono()

  const perm = requirePermission(getDatabase)

  // Permission middleware for collection routes
  app.use('/collections/:collection', perm('access'))
  app.use('/collections/:collection/*', perm('access'))

  // ── SSE: document-level subscription ──────────────────────────
  app.get('/collections/:collection/:id/sse', async (c) => {
    const collection = c.req.param('collection')
    const id = c.req.param('id')
    const database = getDatabase(c)
    await ensureCollection(database, collection)
    const table = qualifiedTable(database, collection)

    return streamSSE(c, async (stream) => {
      const sendSnapshot = async () => {
        const rows = await sql`
          SELECT * FROM ${table} WHERE id = ${id}
        `
        const doc = rows.length > 0 ? formatDoc(rows[0]) : null
        await stream.writeSSE({ event: 'snapshot', data: JSON.stringify(doc) })
      }

      await sendSnapshot()

      const unsub = await subscribe(database, collection, async (event) => {
        if (event.id !== id) return
        try {
          await sendSnapshot()
        } catch {}
      })

      stream.onAbort(() => unsub())
      // keep-alive
      while (true) await stream.sleep(30000)
    })
  })

  // ── SSE: collection / query subscription ──────────────────────
  app.get('/collections/:collection/sse', async (c) => {
    const collection = c.req.param('collection')
    const database = getDatabase(c)
    await ensureCollection(database, collection)

    const whereParam = c.req.query('where')
    const orderBy = c.req.query('orderBy')
    const order = c.req.query('order')
    const limitParam = c.req.query('limit')

    return streamSSE(c, async (stream) => {
      const sendSnapshot = async () => {
        const { query, params } = buildQuery(
          database,
          collection,
          whereParam,
          orderBy,
          order,
          limitParam
        )
        const rows = await sql.unsafe(query, params as any[])
        await stream.writeSSE({
          event: 'snapshot',
          data: JSON.stringify(rows.map(formatDoc)),
        })
      }

      await sendSnapshot()

      const unsub = await subscribe(database, collection, async () => {
        try {
          await sendSnapshot()
        } catch {}
      })

      stream.onAbort(() => unsub())
      while (true) await stream.sleep(30000)
    })
  })

  // ── List collections ─────────────────────────────────────────
  app.get('/collections', async (c) => {
    const database = getDatabase(c)
    const schema = `db_${database}`
    const rows = await sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = ${schema} AND table_name LIKE 'col_%'
      ORDER BY table_name
    `
    return c.json(rows.map((r) => (r.table_name as string).slice(4)))
  })

  // ── CRUD ──────────────────────────────────────────────────────
  app.post('/collections/:collection', async (c) => {
    const collection = c.req.param('collection')
    const database = getDatabase(c)
    await ensureCollection(database, collection)
    const table = qualifiedTable(database, collection)

    const body = await c.req.json()
    const id = generateId()
    const now = Date.now()

    const rows = await sql`
      INSERT INTO ${table} (id, data, created_at, updated_at)
      VALUES (${id}, ${sql.json(body)}, ${now}, ${now})
      RETURNING *
    `

    const doc = formatDoc(rows[0])
    await publishChange({ type: 'added', id: doc.id, collection, database })
    return c.json(doc, 201)
  })

  app.get('/collections/:collection', async (c) => {
    const collection = c.req.param('collection')
    const database = getDatabase(c)
    await ensureCollection(database, collection)

    const { query, params } = buildQuery(
      database,
      collection,
      c.req.query('where'),
      c.req.query('orderBy'),
      c.req.query('order'),
      c.req.query('limit')
    )
    const rows = await sql.unsafe(query, params as any[])
    return c.json(rows.map(formatDoc))
  })

  app.get('/collections/:collection/:id', async (c) => {
    const collection = c.req.param('collection')
    const id = c.req.param('id')
    const database = getDatabase(c)
    await ensureCollection(database, collection)
    const table = qualifiedTable(database, collection)

    const rows = await sql`
      SELECT * FROM ${table} WHERE id = ${id}
    `
    if (rows.length === 0) {
      return c.json({ error: 'Document not found' }, 404)
    }
    return c.json(formatDoc(rows[0]))
  })

  app.put('/collections/:collection/:id', async (c) => {
    const collection = c.req.param('collection')
    const id = c.req.param('id')
    const database = getDatabase(c)
    await ensureCollection(database, collection)
    const table = qualifiedTable(database, collection)

    const body = await c.req.json()
    const now = Date.now()

    const rows = await sql`
      INSERT INTO ${table} (id, data, created_at, updated_at)
      VALUES (${id}, ${sql.json(body)}, ${now}, ${now})
      ON CONFLICT (id)
      DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at
      RETURNING *, (xmax = 0) AS is_new
    `

    const doc = formatDoc(rows[0])
    const type = rows[0].is_new ? 'added' : 'modified'
    await publishChange({ type, id: doc.id, collection, database })
    return c.json(doc)
  })

  app.patch('/collections/:collection/:id', async (c) => {
    const collection = c.req.param('collection')
    const id = c.req.param('id')
    const database = getDatabase(c)
    await ensureCollection(database, collection)
    const table = qualifiedTable(database, collection)

    const body = await c.req.json()
    const now = Date.now()

    const rows = await sql`
      UPDATE ${table} SET data = data || ${sql.json(body)}, updated_at = ${now}
      WHERE id = ${id}
      RETURNING *
    `

    if (rows.length === 0) {
      return c.json({ error: 'Document not found' }, 404)
    }

    const doc = formatDoc(rows[0])
    await publishChange({ type: 'modified', id: doc.id, collection, database })
    return c.json(doc)
  })

  app.delete('/collections/:collection/:id', async (c) => {
    const collection = c.req.param('collection')
    const id = c.req.param('id')
    const database = getDatabase(c)
    await ensureCollection(database, collection)
    const table = qualifiedTable(database, collection)

    const rows = await sql`
      DELETE FROM ${table} WHERE id = ${id}
      RETURNING *
    `

    if (rows.length === 0) {
      return c.json({ error: 'Document not found' }, 404)
    }

    await publishChange({ type: 'removed', id: rows[0].id as string, collection, database })
    return c.json({ success: true })
  })

  return app
}

// ── Admin routes (database management) ──────────────────────
const adminRoutes = new Hono()

adminRoutes.get('/health', (c) => c.json({ status: 'ok' }))

// List databases — public (console needs it without auth)
adminRoutes.get('/databases', async (c) => {
  const rows = await sql`
    SELECT schema_name FROM information_schema.schemata
    WHERE schema_name LIKE 'db_%'
    ORDER BY schema_name
  `
  return c.json(rows.map((r) => (r.schema_name as string).slice(3)))
})

// Delete database — admin only
adminRoutes.delete('/db/:database', async (c) => {
  const role = c.get('role') || 'anonymous'
  if (role !== 'admin') {
    return c.json({ error: role === 'anonymous' ? 'Unauthorized' : 'Forbidden' }, role === 'anonymous' ? 401 : 403)
  }

  const database = c.req.param('database')

  if (database === 'default') {
    return c.json({ error: 'Cannot delete the default database' }, 400)
  }

  const schema = sql(`db_${database}`)
  await sql`DROP SCHEMA IF EXISTS ${schema} CASCADE`
  clearDatabaseCaches(database)

  return c.json({ success: true })
})

// Legacy routes (default database)
const legacyRoutes = collectionRoutes(() => 'default')

// Database-aware routes
const dbRoutes = collectionRoutes((c) => c.req.param('database'))

export { legacyRoutes, dbRoutes, adminRoutes }
