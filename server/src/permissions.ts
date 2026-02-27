import type { Context } from 'hono'
import { Hono } from 'hono'
import { sql, ensureDatabase, qualifiedConfig } from './db.js'
import { clearPermissionCache } from './middleware.js'

const VALID_LEVELS = ['public', 'authenticated', 'admin']

function permissionRoutes(getDatabase: (c: Context) => string) {
  const app = new Hono()

  // ── GET /collections/:collection/permissions ────────────────
  app.get('/collections/:collection/permissions', async (c) => {
    const role = c.get('role') || 'anonymous'
    if (role !== 'admin') {
      return c.json({ error: role === 'anonymous' ? 'Unauthorized' : 'Forbidden' }, role === 'anonymous' ? 401 : 403)
    }

    const database = getDatabase(c)
    const collection = c.req.param('collection')
    await ensureDatabase(database)

    const configTable = qualifiedConfig(database)
    const rows = await sql`
      SELECT level FROM ${configTable} WHERE collection = ${collection}
    `
    const level = rows.length > 0 ? (rows[0].level as string) : 'public'
    return c.json({ database, collection, level })
  })

  // ── PUT /collections/:collection/permissions ────────────────
  app.put('/collections/:collection/permissions', async (c) => {
    const role = c.get('role') || 'anonymous'
    if (role !== 'admin') {
      return c.json({ error: role === 'anonymous' ? 'Unauthorized' : 'Forbidden' }, role === 'anonymous' ? 401 : 403)
    }

    const database = getDatabase(c)
    const collection = c.req.param('collection')
    const { level } = await c.req.json()

    if (!VALID_LEVELS.includes(level)) {
      return c.json({ error: `Invalid level. Must be one of: ${VALID_LEVELS.join(', ')}` }, 400)
    }

    await ensureDatabase(database)

    const configTable = qualifiedConfig(database)
    await sql`
      INSERT INTO ${configTable} (collection, level)
      VALUES (${collection}, ${level})
      ON CONFLICT (collection) DO UPDATE SET level = EXCLUDED.level
    `

    clearPermissionCache(`${database}:${collection}`)
    return c.json({ database, collection, level })
  })

  return app
}

// Legacy routes (default database)
const permissions = permissionRoutes(() => 'default')

// Database-aware routes
const dbPermissions = permissionRoutes((c) => c.req.param('database'))

export { permissions, dbPermissions }
