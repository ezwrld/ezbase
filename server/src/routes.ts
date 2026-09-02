import type { Context } from 'hono'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { keepAlive } from './sse.js'
import { sql, ensureCollection, qualifiedTable, clearDatabaseCaches } from './db.js'
import { generateId } from './id.js'
import { parseFields, prepareQuery } from './query.js'
import { publishChange, subscribe } from './pubsub.js'
import { canReadCollection, requirePermission } from './middleware.js'
import type { AppliedFilter } from './rules.js'

// ── Helpers ───────────────────────────────────────────────────
type JsonValue = Parameters<typeof sql.json>[0]

function formatDoc(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    data: row.data as Record<string, unknown>,
    created: Number(row.created_at),
    updated: Number(row.updated_at),
  }
}

export function documentEtag(updated: number): string {
  return `"${updated}"`
}

export function parseDocumentEtag(value?: string): number | null {
  if (value === undefined) return null
  const match = value.match(/^"([1-9][0-9]*)"$/)
  const updated = match ? Number(match[1]) : NaN
  if (!Number.isSafeInteger(updated)) {
    throw new Error('If-Match must contain one document ETag')
  }
  return updated
}

/**
 * Enforce rule filters on incoming document data (create/replace).
 * Single-value filter fields (e.g. owner's userId = auth.id) are auto-stamped
 * when absent — `add({ text })` just works — and rejected on mismatch, so users
 * can't create docs outside their own scope. Array-valued filters (array claims)
 * can't be auto-picked: the field is required and must be one of the allowed values.
 * Returns an error message, or null if `data` is valid (possibly mutated by stamping).
 */
function enforceFiltersOnWrite(data: Record<string, unknown>, filters: AppliedFilter[]): string | null {
  for (const f of filters) {
    if (f.values) {
      if (data[f.field] === undefined) {
        return `Field "${f.field}" is required (must be one of your permitted values)`
      }
      if (!f.values.includes(String(data[f.field]))) {
        return `Field "${f.field}" must be one of your permitted values`
      }
    } else if (f.value !== null) {
      if (data[f.field] === undefined) {
        data[f.field] = f.value
      } else if (String(data[f.field]) !== f.value) {
        return `Field "${f.field}" must be "${f.value}"`
      }
    }
  }
  return null
}

/** PATCH may not move a doc out of the caller's filter scope */
function patchViolatesFilters(patch: Record<string, unknown>, filters: AppliedFilter[]): string | null {
  for (const f of filters) {
    if (patch[f.field] === undefined) continue
    if (f.values) {
      if (!f.values.includes(String(patch[f.field]))) {
        return `Field "${f.field}" must be one of your permitted values`
      }
    } else if (f.value !== null && String(patch[f.field]) !== f.value) {
      return `Field "${f.field}" must be "${f.value}"`
    }
  }
  return null
}

function docMatchesFilters(data: Record<string, unknown>, filters: AppliedFilter[]): boolean {
  for (const f of filters) {
    const docValue = String(data[f.field] ?? '')
    if (f.values) {
      if (!f.values.includes(docValue)) return false
    } else if (f.value !== null) {
      if (docValue !== f.value) return false
    }
  }
  return true
}

const MAX_JSON_BYTES = parseInt(process.env.EZBASE_MAX_JSON_BYTES || String(1024 * 1024), 10)

async function readJsonBody(c: Context): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: Response }> {
  const declared = parseInt(c.req.header('content-length') || '0', 10)
  if (declared > MAX_JSON_BYTES) {
    return { ok: false, response: c.json({ error: 'Payload too large' }, 413) }
  }
  const body = await c.req.json() as Record<string, unknown>
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_JSON_BYTES) {
    return { ok: false, response: c.json({ error: 'Payload too large' }, 413) }
  }
  return { ok: true, body }
}

// ── Collection routes factory ────────────────────────────────
function collectionRoutes(getDatabase: (c: Context) => string) {
  const app = new Hono()

  const perm = requirePermission(getDatabase)

  // Permission middleware — GET = read, everything else = write
  app.use('/collections/:collection', async (c, next) => {
    const action = c.req.method === 'GET' ? 'read' : 'write'
    return perm(action)(c, next)
  })
  app.use('/collections/:collection/*', async (c, next) => {
    const action = c.req.method === 'GET' ? 'read' : 'write'
    return perm(action)(c, next)
  })

  // ── SSE: document-level subscription ──────────────────────────
  app.get('/collections/:collection/:id/sse', async (c) => {
    const collection = c.req.param('collection')
    const id = c.req.param('id')
    const database = getDatabase(c)
    const docFilters = c.get('docFilters') as AppliedFilter[] | undefined
    await ensureCollection(database, collection)
    const table = qualifiedTable(database, collection)

    return streamSSE(c, async (stream) => {
      const sendSnapshot = async () => {
        const rows = await sql`
          SELECT * FROM ${table} WHERE id = ${id}
        `
        let doc = rows.length > 0 ? formatDoc(rows[0]) : null
        if (doc && docFilters && !docMatchesFilters(doc.data as Record<string, unknown>, docFilters)) {
          doc = null
        }
        await stream.writeSSE({ event: 'snapshot', data: JSON.stringify(doc) })
      }

      await sendSnapshot()

      const unsub = await subscribe(database, collection, async (event) => {
        if (event.id !== id) return
        try {
          await sendSnapshot()
        } catch {}
      })

      try {
        await keepAlive(stream)
      } finally {
        unsub()
      }
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
    const offsetParam = c.req.query('offset')
    let fields: string[] | undefined
    try {
      fields = parseFields(c.req.query('fields'))
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Invalid fields' }, 400)
    }
    const docFilters = c.get('docFilters') as AppliedFilter[] | undefined

    return streamSSE(c, async (stream) => {
      const sendSnapshot = async () => {
        const { query, params } = await prepareQuery(
          database,
          collection,
          whereParam,
          orderBy,
          order,
          limitParam,
          docFilters,
          offsetParam,
          fields,
          (c.get('role') || 'anonymous') === 'admin'
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

      try {
        await keepAlive(stream)
      } finally {
        unsub()
      }
    })
  })

  // ── Stats (admin-only, used by console dashboard) ─────────
  app.get('/collections/:collection/stats', async (c) => {
    const role = c.get('role') || 'anonymous'
    if (role !== 'admin') {
      return c.json({ error: role === 'anonymous' ? 'Unauthorized' : 'Forbidden' }, role === 'anonymous' ? 401 : 403)
    }

    const collection = c.req.param('collection')
    const database = getDatabase(c)
    await ensureCollection(database, collection)
    const table = qualifiedTable(database, collection)

    const rows = await sql`
      SELECT COUNT(*)::int AS count,
             COALESCE(SUM(pg_column_size(data)), 0)::bigint AS size
      FROM ${table}
    `
    return c.json({ count: rows[0].count, size: Number(rows[0].size) })
  })

  // ── List collections ─────────────────────────────────────────
  app.get('/collections', async (c) => {
    const database = getDatabase(c)
    const schema = `db_${database}`
    const role = c.get('role') || 'anonymous'
    const rows = await sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = ${schema} AND table_name LIKE 'col_%'
      ORDER BY table_name
    `
    const names = rows.map((r) => (r.table_name as string).slice(4))
    return c.json(names.filter((name) => canReadCollection(role, name)))
  })

  // ── CRUD ──────────────────────────────────────────────────────
  app.post('/collections/:collection', async (c) => {
    const collection = c.req.param('collection')
    const database = getDatabase(c)
    await ensureCollection(database, collection)
    const table = qualifiedTable(database, collection)

    const parsed = await readJsonBody(c)
    if (!parsed.ok) return parsed.response
    const body = parsed.body

    const createFilters = c.get('docFilters') as AppliedFilter[] | undefined
    if (createFilters) {
      const err = enforceFiltersOnWrite(body, createFilters)
      if (err) return c.json({ error: err }, 403)
    }

    const id = generateId()
    const now = Date.now()

    const rows = await sql`
      INSERT INTO ${table} (id, data, created_at, updated_at)
      VALUES (${id}, ${sql.json(body as JsonValue)}, ${now}, ${now})
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

    const docFilters = c.get('docFilters') as AppliedFilter[] | undefined
    let query: string
    let params: unknown[]
    try {
      ({ query, params } = await prepareQuery(
        database,
        collection,
        c.req.query('where'),
        c.req.query('orderBy'),
        c.req.query('order'),
        c.req.query('limit'),
        docFilters,
        c.req.query('offset'),
        parseFields(c.req.query('fields')),
        (c.get('role') || 'anonymous') === 'admin'
      ))
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Invalid query' }, 400)
    }
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
    // Filter check — return 404 (not 403) to avoid leaking existence
    const singleFilters = c.get('docFilters') as AppliedFilter[] | undefined
    if (singleFilters) {
      const data = rows[0].data as Record<string, unknown>
      if (!docMatchesFilters(data, singleFilters)) {
        return c.json({ error: 'Document not found' }, 404)
      }
    }
    const doc = formatDoc(rows[0])
    c.header('ETag', documentEtag(doc.updated))
    return c.json(doc)
  })

  app.put('/collections/:collection/:id', async (c) => {
    const collection = c.req.param('collection')
    const id = c.req.param('id')
    const database = getDatabase(c)
    await ensureCollection(database, collection)
    const table = qualifiedTable(database, collection)

    // Filter check on existing doc before overwrite
    const putFilters = c.get('docFilters') as AppliedFilter[] | undefined
    if (putFilters) {
      const existing = await sql`SELECT data FROM ${table} WHERE id = ${id}`
      if (existing.length > 0) {
        const data = existing[0].data as Record<string, unknown>
        if (!docMatchesFilters(data, putFilters)) {
          return c.json({ error: 'Document not found' }, 404)
        }
      }
    }

    const parsed = await readJsonBody(c)
    if (!parsed.ok) return parsed.response
    const body = parsed.body

    // Replacement data must also stay inside the caller's filter scope
    if (putFilters) {
      const err = enforceFiltersOnWrite(body, putFilters)
      if (err) return c.json({ error: err }, 403)
    }

    const now = Date.now()

    const rows = await sql`
      INSERT INTO ${table} (id, data, created_at, updated_at)
      VALUES (${id}, ${sql.json(body as JsonValue)}, ${now}, ${now})
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

    // Filter check before update
    const patchFilters = c.get('docFilters') as AppliedFilter[] | undefined
    if (patchFilters) {
      const existing = await sql`SELECT data FROM ${table} WHERE id = ${id}`
      if (existing.length === 0) return c.json({ error: 'Document not found' }, 404)
      const data = existing[0].data as Record<string, unknown>
      if (!docMatchesFilters(data, patchFilters)) {
        return c.json({ error: 'Document not found' }, 404)
      }
    }

    const parsed = await readJsonBody(c)
    if (!parsed.ok) return parsed.response
    const body = parsed.body

    // A patch may not move the doc out of the caller's filter scope
    if (patchFilters) {
      const err = patchViolatesFilters(body, patchFilters)
      if (err) return c.json({ error: err }, 403)
    }

    let expectedUpdated: number | null
    try {
      expectedUpdated = parseDocumentEtag(c.req.header('If-Match'))
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Invalid If-Match' }, 400)
    }

    const now = Date.now()
    const rows = expectedUpdated === null
      ? await sql`
          UPDATE ${table}
          SET data = data || ${sql.json(body as JsonValue)}, updated_at = GREATEST(${now}, updated_at + 1)
          WHERE id = ${id}
          RETURNING *
        `
      : await sql`
          UPDATE ${table}
          SET data = data || ${sql.json(body as JsonValue)}, updated_at = GREATEST(${now}, updated_at + 1)
          WHERE id = ${id} AND updated_at = ${expectedUpdated}
          RETURNING *
        `

    if (rows.length === 0) {
      if (expectedUpdated !== null) {
        const existing = await sql`SELECT 1 FROM ${table} WHERE id = ${id}`
        if (existing.length > 0) {
          return c.json({ error: 'Document changed; fetch it and retry' }, 412)
        }
      }
      return c.json({ error: 'Document not found' }, 404)
    }

    const doc = formatDoc(rows[0])
    await publishChange({ type: 'modified', id: doc.id, collection, database })
    c.header('ETag', documentEtag(doc.updated))
    return c.json(doc)
  })

  app.delete('/collections/:collection/:id', async (c) => {
    const collection = c.req.param('collection')
    const id = c.req.param('id')
    const database = getDatabase(c)
    await ensureCollection(database, collection)
    const table = qualifiedTable(database, collection)

    // Filter check before delete
    const deleteFilters = c.get('docFilters') as AppliedFilter[] | undefined
    if (deleteFilters) {
      const existing = await sql`SELECT data FROM ${table} WHERE id = ${id}`
      if (existing.length === 0) return c.json({ error: 'Document not found' }, 404)
      const data = existing[0].data as Record<string, unknown>
      if (!docMatchesFilters(data, deleteFilters)) {
        return c.json({ error: 'Document not found' }, 404)
      }
    }

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

adminRoutes.get('/health', (c) => c.json({ status: 'ok', version: process.env.EZBASE_VERSION || 'dev' }))

// List databases
adminRoutes.get('/databases', async (c) => {
  const role = c.get('role') || 'anonymous'
  if (role !== 'admin') {
    return c.json({ error: role === 'anonymous' ? 'Unauthorized' : 'Forbidden' }, role === 'anonymous' ? 401 : 403)
  }

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
const dbRoutes = collectionRoutes((c) => c.req.param('database')!)

export { legacyRoutes, dbRoutes, adminRoutes }
