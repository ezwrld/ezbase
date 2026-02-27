import type { Context, Next } from 'hono'
import { verify } from 'hono/jwt'
import { getAdminKey, getJwtSecret } from './config.js'
import { sql } from './db.js'

// ── Cache for permission levels ─────────────────────────────
const permissionCache = new Map<string, { level: string; expires: number }>()
const CACHE_TTL = 30_000

export function clearPermissionCache(collection?: string) {
  if (collection) {
    permissionCache.delete(collection)
  } else {
    permissionCache.clear()
  }
}

async function getPermissionLevel(collection: string): Promise<string> {
  const cached = permissionCache.get(collection)
  if (cached && cached.expires > Date.now()) return cached.level

  const rows = await sql`
    SELECT level FROM _ezbase_config WHERE collection = ${collection}
  `
  const level = rows.length > 0 ? (rows[0].level as string) : 'public'
  permissionCache.set(collection, { level, expires: Date.now() + CACHE_TTL })
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

  // Try JWT
  try {
    const payload = await verify(token, getJwtSecret())
    c.set('role', payload.role || 'user')
    c.set('userId', payload.sub)
    return next()
  } catch {
    c.set('role', 'anonymous')
    return next()
  }
}

// ── requirePermission — applied to collection routes ────────
export function requirePermission(action: string) {
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

    const level = await getPermissionLevel(collection)

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
