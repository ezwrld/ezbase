import type { Context, Next } from 'hono'
import { getAdminKey } from './config.js'
import { ba } from './auth.js'
import { sql, qualifiedConfig } from './db.js'

// ── Cache for permission levels ─────────────────────────────
const permissionCache = new Map<string, { level: string; expires: number }>()
const CACHE_TTL = 30_000

export function clearPermissionCache(key?: string) {
  if (key) {
    permissionCache.delete(key)
  } else {
    permissionCache.clear()
  }
}

async function getPermissionLevel(database: string, collection: string): Promise<string> {
  const cacheKey = `${database}:${collection}`
  const cached = permissionCache.get(cacheKey)
  if (cached && cached.expires > Date.now()) return cached.level

  const configTable = qualifiedConfig(database)
  const rows = await sql`
    SELECT level FROM ${configTable} WHERE collection = ${collection}
  `
  const level = rows.length > 0 ? (rows[0].level as string) : 'public'
  permissionCache.set(cacheKey, { level, expires: Date.now() + CACHE_TTL })
  return level
}

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
      return next()
    }
  } catch {}

  c.set('role', 'anonymous')
  return next()
}

// ── requirePermission — applied to collection routes ────────
export function requirePermission(getDatabase: (c: Context) => string) {
  return (action: string) => {
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

      const database = getDatabase(c)
      const level = await getPermissionLevel(database, collection)

      if (level === 'public') return next()

      if (level === 'authenticated') {
        if (role === 'anonymous') {
          return c.json({ error: 'Unauthorized' }, 401)
        }
        return next()
      }

      if (level === 'admin') {
        if (role === 'anonymous') return c.json({ error: 'Unauthorized' }, 401)
        return c.json({ error: 'Forbidden' }, 403)
      }

      return next()
    }
  }
}
