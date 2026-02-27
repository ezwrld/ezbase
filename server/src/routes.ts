import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { sql, ensureCollection } from './db.js'
import { generateId } from './id.js'
import { publishChange, subscribe } from './pubsub.js'
import { requirePermission } from './middleware.js'

const api = new Hono()

api.get('/health', (c) => c.json({ status: 'ok' }))

// ── Permission middleware for collection routes ─────────────
api.use('/collections/:collection', requirePermission('access'))
api.use('/collections/:collection/*', requirePermission('access'))

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
  collection: string,
  whereParam?: string,
  orderBy?: string,
  order?: string,
  limitParam?: string
) {
  let query = `SELECT * FROM col_${collection} WHERE true`
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

// ── SSE: document-level subscription ──────────────────────────
api.get('/collections/:collection/:id/sse', async (c) => {
  const { collection, id } = c.req.param()
  await ensureCollection(collection)
  const table = sql(`col_${collection}`)

  return streamSSE(c, async (stream) => {
    const sendSnapshot = async () => {
      const rows = await sql`
        SELECT * FROM ${table} WHERE id = ${id}
      `
      const doc = rows.length > 0 ? formatDoc(rows[0]) : null
      await stream.writeSSE({ event: 'snapshot', data: JSON.stringify(doc) })
    }

    await sendSnapshot()

    const unsub = await subscribe(collection, async (event) => {
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
api.get('/collections/:collection/sse', async (c) => {
  const collection = c.req.param('collection')
  await ensureCollection(collection)

  const whereParam = c.req.query('where')
  const orderBy = c.req.query('orderBy')
  const order = c.req.query('order')
  const limitParam = c.req.query('limit')

  return streamSSE(c, async (stream) => {
    const sendSnapshot = async () => {
      const { query, params } = buildQuery(
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

    const unsub = await subscribe(collection, async () => {
      try {
        await sendSnapshot()
      } catch {}
    })

    stream.onAbort(() => unsub())
    while (true) await stream.sleep(30000)
  })
})

// ── List collections ─────────────────────────────────────────
api.get('/collections', async (c) => {
  const rows = await sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name LIKE 'col_%'
    ORDER BY table_name
  `
  return c.json(rows.map((r) => (r.table_name as string).slice(4)))
})

// ── CRUD ──────────────────────────────────────────────────────
api.post('/collections/:collection', async (c) => {
  const collection = c.req.param('collection')
  await ensureCollection(collection)
  const table = sql(`col_${collection}`)

  const body = await c.req.json()
  const id = generateId()
  const now = Date.now()

  const rows = await sql`
    INSERT INTO ${table} (id, data, created_at, updated_at)
    VALUES (${id}, ${sql.json(body)}, ${now}, ${now})
    RETURNING *
  `

  const doc = formatDoc(rows[0])
  await publishChange({ type: 'added', id: doc.id, collection })
  return c.json(doc, 201)
})

api.get('/collections/:collection', async (c) => {
  const collection = c.req.param('collection')
  await ensureCollection(collection)

  const { query, params } = buildQuery(
    collection,
    c.req.query('where'),
    c.req.query('orderBy'),
    c.req.query('order'),
    c.req.query('limit')
  )
  const rows = await sql.unsafe(query, params as any[])
  return c.json(rows.map(formatDoc))
})

api.get('/collections/:collection/:id', async (c) => {
  const { collection, id } = c.req.param()
  await ensureCollection(collection)
  const table = sql(`col_${collection}`)

  const rows = await sql`
    SELECT * FROM ${table} WHERE id = ${id}
  `
  if (rows.length === 0) {
    return c.json({ error: 'Document not found' }, 404)
  }
  return c.json(formatDoc(rows[0]))
})

api.put('/collections/:collection/:id', async (c) => {
  const { collection, id } = c.req.param()
  await ensureCollection(collection)
  const table = sql(`col_${collection}`)

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
  await publishChange({ type, id: doc.id, collection })
  return c.json(doc)
})

api.patch('/collections/:collection/:id', async (c) => {
  const { collection, id } = c.req.param()
  await ensureCollection(collection)
  const table = sql(`col_${collection}`)

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
  await publishChange({ type: 'modified', id: doc.id, collection })
  return c.json(doc)
})

api.delete('/collections/:collection/:id', async (c) => {
  const { collection, id } = c.req.param()
  await ensureCollection(collection)
  const table = sql(`col_${collection}`)

  const rows = await sql`
    DELETE FROM ${table} WHERE id = ${id}
    RETURNING *
  `

  if (rows.length === 0) {
    return c.json({ error: 'Document not found' }, 404)
  }

  await publishChange({ type: 'removed', id: rows[0].id as string, collection })
  return c.json({ success: true })
})

export { api }
