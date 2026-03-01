import type { Context, Next } from 'hono'
import { getAdminKey } from './config.js'
import { ba } from './auth.js'
import { getRuleForCollection, resolveFilters } from './rules.js'

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

// ── requirePermission — applied to collection routes ────────
export function requirePermission(getDatabase: (c: Context) => string) {
  return (action: 'read' | 'write') => {
    return async (c: Context, next: Next) => {
      const role = c.get('role') || 'anonymous'

      // Admin always passes
      if (role === 'admin') return next()

      // Extract collection name from path
      const collection = c.req.param('collection')
      if (!collection) return next()

      // Protect internal tables
      if (collection.startsWith('_ezbase_')) {
        if (role === 'anonymous') return c.json({ error: 'Unauthorized' }, 401)
        return c.json({ error: 'Forbidden' }, 403)
      }

      const rule = getRuleForCollection(collection, action)

      // Access gate
      if (rule.access === 'public') {
        // pass
      } else if (rule.access === 'authenticated') {
        if (role === 'anonymous') return c.json({ error: 'Unauthorized' }, 401)
      } else if (rule.access === 'admin') {
        if (role === 'anonymous') return c.json({ error: 'Unauthorized' }, 401)
        return c.json({ error: 'Forbidden' }, 403)
      } else if (rule.access.startsWith('role:')) {
        const required = rule.access.slice(5)
        if (role === 'anonymous') return c.json({ error: 'Unauthorized' }, 401)
        if (role !== required) return c.json({ error: 'Forbidden' }, 403)
      }

      // Resolve filters
      if (rule.filters.length > 0) {
        const userId = c.get('userId') as string | undefined
        const claims = (c.get('claims') || {}) as Record<string, unknown>
        const applied = resolveFilters(rule, userId, claims)
        if (applied === null) return c.json({ error: 'Forbidden' }, 403)
        c.set('docFilters', applied)
      }

      return next()
    }
  }
}
