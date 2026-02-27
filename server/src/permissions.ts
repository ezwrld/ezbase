import { Hono } from 'hono'
import { sql } from './db.js'
import { clearPermissionCache } from './middleware.js'

const permissions = new Hono()

const VALID_LEVELS = ['public', 'authenticated', 'admin']

// ── GET /collections/:collection/permissions ────────────────
permissions.get('/collections/:collection/permissions', async (c) => {
  const role = c.get('role') || 'anonymous'
  if (role !== 'admin') {
    return c.json({ error: role === 'anonymous' ? 'Unauthorized' : 'Forbidden' }, role === 'anonymous' ? 401 : 403)
  }

  const collection = c.req.param('collection')
  const rows = await sql`
    SELECT level FROM _ezbase_config WHERE collection = ${collection}
  `
  const level = rows.length > 0 ? (rows[0].level as string) : 'public'
  return c.json({ collection, level })
})

// ── PUT /collections/:collection/permissions ────────────────
permissions.put('/collections/:collection/permissions', async (c) => {
  const role = c.get('role') || 'anonymous'
  if (role !== 'admin') {
    return c.json({ error: role === 'anonymous' ? 'Unauthorized' : 'Forbidden' }, role === 'anonymous' ? 401 : 403)
  }

  const collection = c.req.param('collection')
  const { level } = await c.req.json()

  if (!VALID_LEVELS.includes(level)) {
    return c.json({ error: `Invalid level. Must be one of: ${VALID_LEVELS.join(', ')}` }, 400)
  }

  await sql`
    INSERT INTO _ezbase_config (collection, level)
    VALUES (${collection}, ${level})
    ON CONFLICT (collection) DO UPDATE SET level = EXCLUDED.level
  `

  clearPermissionCache(collection)
  return c.json({ collection, level })
})

export { permissions }
