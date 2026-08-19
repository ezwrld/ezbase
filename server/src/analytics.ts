import { Hono } from 'hono'
import type { Context, Next } from 'hono'
import { streamSSE } from 'hono/streaming'
import { keepAlive } from './sse.js'
import { sql } from './db.js'

/**
 * Built-in activity analytics — dogfooded into ezbase's own Postgres.
 *
 * Every API request is classified and aggregated into per-minute buckets in
 * memory, then flushed to the internal `_ezbase_metrics` table (public schema,
 * same protection class as `_ezbase_files` — unreachable via the collections
 * API, invisible to backups and collection listings). A small in-memory ring
 * of recent requests feeds the live SSE stream. Per-request DB writes would
 * double write load; minute buckets keep the cost near zero.
 *
 * Retention: 14 days, pruned hourly. Flush cadence: EZBASE_METRICS_FLUSH_MS
 * (default 15s — overridden only by test stacks).
 */

const FLUSH_MS = parseInt(process.env.EZBASE_METRICS_FLUSH_MS || '15000', 10)
const RETENTION_MS = 14 * 24 * 60 * 60 * 1000
const LIVE_RING_SIZE = 200

export interface RequestEvent {
  ts: number
  method: string
  path: string
  op: 'read' | 'write' | 'realtime' | 'storage' | 'auth' | 'admin'
  database: string
  collection: string
  status: number
  ms: number
  role: string
}

// ── Classification ────────────────────────────────────────────

const COLLECTION_RE = /^\/api(?:\/db\/([^/]+))?\/collections\/([^/]+)(\/.*)?$/

function withoutBasePath(path: string) {
  const apiStart = path.search(/\/api(?:\/|$)/)
  return apiStart === -1 ? path : path.slice(apiStart)
}

export function classifyRequest(method: string, path: string): Pick<RequestEvent, 'op' | 'database' | 'collection'> {
  path = withoutBasePath(path)
  const m = path.match(COLLECTION_RE)
  if (m) {
    const database = m[1] || 'default'
    const collection = m[2]
    if (m[3]?.endsWith('/sse')) return { op: 'realtime', database, collection }
    return { op: method === 'GET' ? 'read' : 'write', database, collection }
  }
  if (path.startsWith('/api/storage')) return { op: 'storage', database: '', collection: '' }
  if (path.startsWith('/api/auth')) return { op: 'auth', database: '', collection: '' }
  return { op: 'admin', database: '', collection: '' }
}

// ── In-memory state ───────────────────────────────────────────

interface Bucket {
  count: number
  errors: number
  totalMs: number
}

// key: `${minuteTs}|${database}|${collection}|${op}`
const buckets = new Map<string, Bucket>()
const liveRing: RequestEvent[] = []
const liveListeners = new Set<(e: RequestEvent) => void>()

export function recordRequest(event: RequestEvent) {
  const minute = Math.floor(event.ts / 60000) * 60000
  const key = `${minute}|${event.database}|${event.collection}|${event.op}`
  let b = buckets.get(key)
  if (!b) {
    b = { count: 0, errors: 0, totalMs: 0 }
    buckets.set(key, b)
  }
  b.count++
  if (event.status >= 400) b.errors++
  b.totalMs += event.ms

  liveRing.push(event)
  if (liveRing.length > LIVE_RING_SIZE) liveRing.shift()
  for (const l of liveListeners) {
    try { l(event) } catch {}
  }
}

// ── Timing middleware ─────────────────────────────────────────

export function analyticsMiddleware() {
  return async (c: Context, next: Next) => {
    const path = new URL(c.req.url).pathname
    const apiPath = withoutBasePath(path)
    // Don't record ourselves or the health probe
    if (apiPath === '/api/health' || apiPath.startsWith('/api/analytics')) return next()

    const start = Date.now()
    const { op, database, collection } = classifyRequest(c.req.method, path)

    // SSE requests hang open for their lifetime — record at start, no duration
    if (op === 'realtime') {
      recordRequest({
        ts: start, method: c.req.method, path, op, database, collection,
        status: 200, ms: 0, role: c.get('role') || 'anonymous',
      })
      return next()
    }

    try {
      await next()
    } finally {
      recordRequest({
        ts: start, method: c.req.method, path, op, database, collection,
        status: c.res.status, ms: Date.now() - start, role: c.get('role') || 'anonymous',
      })
    }
  }
}

// ── Persistence ───────────────────────────────────────────────

export async function initAnalytics() {
  await sql`
    CREATE TABLE IF NOT EXISTS _ezbase_metrics (
      ts         BIGINT NOT NULL,
      db         TEXT NOT NULL DEFAULT '',
      collection TEXT NOT NULL DEFAULT '',
      op         TEXT NOT NULL,
      count      INT NOT NULL DEFAULT 0,
      errors     INT NOT NULL DEFAULT 0,
      total_ms   BIGINT NOT NULL DEFAULT 0,
      PRIMARY KEY (ts, db, collection, op)
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_metrics_ts ON _ezbase_metrics (ts)`

  setInterval(() => { flush().catch((e) => console.error('ezbase: metrics flush failed', e)) }, FLUSH_MS)
  setInterval(() => { prune().catch(() => {}) }, 60 * 60 * 1000)
}

async function flush() {
  if (buckets.size === 0) return
  const entries = [...buckets.entries()]
  buckets.clear()
  for (const [key, b] of entries) {
    const [ts, database, collection, op] = key.split('|')
    await sql`
      INSERT INTO _ezbase_metrics (ts, db, collection, op, count, errors, total_ms)
      VALUES (${Number(ts)}, ${database}, ${collection}, ${op}, ${b.count}, ${b.errors}, ${b.totalMs})
      ON CONFLICT (ts, db, collection, op) DO UPDATE SET
        count = _ezbase_metrics.count + EXCLUDED.count,
        errors = _ezbase_metrics.errors + EXCLUDED.errors,
        total_ms = _ezbase_metrics.total_ms + EXCLUDED.total_ms
    `
  }
}

async function prune() {
  await sql`DELETE FROM _ezbase_metrics WHERE ts < ${Date.now() - RETENTION_MS}`
}

// ── Routes (admin-only) ───────────────────────────────────────

function requireAdmin(c: Context, next: Next) {
  const role = c.get('role') || 'anonymous'
  if (role !== 'admin') {
    return c.json({ error: role === 'anonymous' ? 'Unauthorized' : 'Forbidden' }, role === 'anonymous' ? 401 : 403)
  }
  return next()
}

const analyticsRoutes = new Hono()
analyticsRoutes.use('/analytics/*', requireAdmin)

// Summary of the last N hours (default 24): totals + per-op + top collections
analyticsRoutes.get('/analytics/summary', async (c) => {
  await flush()
  const hours = Math.min(parseInt(c.req.query('hours') || '24', 10) || 24, 24 * 14)
  const since = Date.now() - hours * 3600_000

  const totals = await sql`
    SELECT COALESCE(SUM(count), 0)::bigint AS requests,
           COALESCE(SUM(errors), 0)::bigint AS errors,
           COALESCE(SUM(total_ms), 0)::bigint AS total_ms
    FROM _ezbase_metrics WHERE ts >= ${since}
  `
  const byOp = await sql`
    SELECT op, SUM(count)::bigint AS requests, SUM(errors)::bigint AS errors
    FROM _ezbase_metrics WHERE ts >= ${since}
    GROUP BY op ORDER BY requests DESC
  `
  const topCollections = await sql`
    SELECT db, collection,
           SUM(count)::bigint AS requests, SUM(errors)::bigint AS errors,
           (SUM(total_ms) / GREATEST(SUM(count), 1))::int AS avg_ms
    FROM _ezbase_metrics
    WHERE ts >= ${since} AND collection != ''
    GROUP BY db, collection ORDER BY requests DESC LIMIT 12
  `

  const requests = Number(totals[0].requests)
  return c.json({
    hours,
    requests,
    errors: Number(totals[0].errors),
    avgMs: requests > 0 ? Math.round(Number(totals[0].total_ms) / requests) : 0,
    byOp: byOp.map((r) => ({ op: r.op, requests: Number(r.requests), errors: Number(r.errors) })),
    topCollections: topCollections.map((r) => ({
      database: r.db, collection: r.collection,
      requests: Number(r.requests), errors: Number(r.errors), avgMs: r.avg_ms,
    })),
  })
})

// Per-minute time series for charts
analyticsRoutes.get('/analytics/timeseries', async (c) => {
  await flush()
  const minutes = Math.min(parseInt(c.req.query('minutes') || '60', 10) || 60, 24 * 60 * 14)
  const database = c.req.query('database')
  const collection = c.req.query('collection')
  const since = Math.floor((Date.now() - minutes * 60000) / 60000) * 60000

  const rows = await sql`
    SELECT ts, SUM(count)::bigint AS requests, SUM(errors)::bigint AS errors,
           (SUM(total_ms) / GREATEST(SUM(count), 1))::int AS avg_ms
    FROM _ezbase_metrics
    WHERE ts >= ${since}
      AND (${database ?? null}::text IS NULL OR db = ${database ?? ''})
      AND (${collection ?? null}::text IS NULL OR collection = ${collection ?? ''})
    GROUP BY ts ORDER BY ts
  `
  return c.json(rows.map((r) => ({
    ts: Number(r.ts), requests: Number(r.requests), errors: Number(r.errors), avgMs: r.avg_ms,
  })))
})

// Live request feed (SSE) — recent ring first, then real-time
analyticsRoutes.get('/analytics/live', (c) => {
  return streamSSE(c, async (stream) => {
    for (const e of liveRing.slice(-50)) {
      await stream.writeSSE({ event: 'request', data: JSON.stringify(e) })
    }
    const listener = (e: RequestEvent) => {
      stream.writeSSE({ event: 'request', data: JSON.stringify(e) }).catch(() => {})
    }
    liveListeners.add(listener)
    try {
      await keepAlive(stream)
    } finally {
      liveListeners.delete(listener)
    }
  })
})

export { analyticsRoutes }
