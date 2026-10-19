import type { Context, Next } from 'hono'
import { getAdminKey } from './config.js'
import { ba } from './auth.js'
import { getRuleForCollection, resolveFilters, type AppliedFilter } from './rules.js'

// ── extractAuth — runs on ALL requests, never rejects ───────
export async function extractAuth(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization')
  const token =
    authHeader?.startsWith('Bearer ')
      ? authHeader.slice(7)
      : c.req.query('token')

  if (!token) {
    c.set('role', 'anonymous')
    return next()
  }

  // Check admin key first
  if (token === getAdminKey()) {
    c.set('role', 'admin')
    c.set('claims', {})
    return next()
  }

  // Try BetterAuth session
  try {
    // Construct headers for BetterAuth — handles both header and query param tokens
    const headers = new Headers()
    headers.set('Authorization', `Bearer ${token}`)

    const session = await ba.api.getSession({ headers })
    if (session) {
      c.set('role', (session as any).user?.role || 'user')
      c.set('userId', (session as any).user?.id)
      let claims: Record<string, unknown> = {}
      try { claims = JSON.parse((session as any).user?.claims || '{}') } catch {}
      c.set('claims', claims)
      return next()
    }
  } catch {}

  c.set('role', 'anonymous')
  return next()
}

export type CollectionAccess =
  | { ok: true; filters?: AppliedFilter[] }
  | { ok: false; status: 401 | 403; error: 'Unauthorized' | 'Forbidden' }

const UNAUTHORIZED = { ok: false, status: 401, error: 'Unauthorized' } as const
const FORBIDDEN = { ok: false, status: 403, error: 'Forbidden' } as const

/** Whether the caller may read/write a collection, and the doc filters its rule imposes. */
export function checkCollectionAccess(c: Context, collection: string, action: 'read' | 'write'): CollectionAccess {
  const role = c.get('role') || 'anonymous'

  // Admin always passes
  if (role === 'admin') return { ok: true }

  // Protect internal tables
  if (collection.startsWith('_ezbase_')) return role === 'anonymous' ? UNAUTHORIZED : FORBIDDEN

  const rule = getRuleForCollection(collection, action)

  // Access gate
  if (rule.access === 'public') {
    // pass
  } else if (rule.access === 'authenticated') {
    if (role === 'anonymous') return UNAUTHORIZED
  } else if (rule.access === 'admin') {
    return role === 'anonymous' ? UNAUTHORIZED : FORBIDDEN
  } else if (rule.access.startsWith('role:')) {
    if (role === 'anonymous') return UNAUTHORIZED
    if (role !== rule.access.slice(5)) return FORBIDDEN
  }

  // Resolve filters
  if (rule.filters.length > 0) {
    const userId = c.get('userId') as string | undefined
    const claims = (c.get('claims') || {}) as Record<string, unknown>
    const applied = resolveFilters(rule, userId, claims)
    if (applied === null) return FORBIDDEN
    return { ok: true, filters: applied }
  }

  return { ok: true }
}

// ── requirePermission — applied to collection routes ────────
export function requirePermission(getDatabase: (c: Context) => string) {
  return (action: 'read' | 'write') => {
    return async (c: Context, next: Next) => {
      // Extract collection name from path
      const collection = c.req.param('collection')
      if (!collection) return next()

      const access = checkCollectionAccess(c, collection, action)
      if (!access.ok) return c.json({ error: access.error }, access.status)
      if (access.filters) c.set('docFilters', access.filters)

      return next()
    }
  }
}

/** Whether this caller may learn that a collection exists (list endpoint). */
export function canReadCollection(role: string, collection: string): boolean {
  if (collection.startsWith('_ezbase_')) return role === 'admin'
  if (role === 'admin') return true

  const rule = getRuleForCollection(collection, 'read')
  if (rule.access === 'public') return true
  if (rule.access === 'authenticated') return role !== 'anonymous'
  if (rule.access === 'admin') return false
  if (rule.access.startsWith('role:')) return role === rule.access.slice(5)
  return false
}
