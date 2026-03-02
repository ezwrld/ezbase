import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { init, migrateToSchemas, validateDatabaseName } from './db.js'
import { initPubSub } from './pubsub.js'
import { initConfig, getPublicUrl } from './config.js'
import { extractAuth } from './middleware.js'
import { legacyRoutes, dbRoutes, adminRoutes } from './routes.js'
import { auth, initAuth } from './auth.js'
import { loadRules, watchRules, rulesRoutes, legacyPermissionRoutes, dbLegacyPermissionRoutes } from './rules.js'
import { storageRoutes } from './storage.js'

const { basePath } = getPublicUrl()
const app = basePath ? new Hono().basePath(basePath) : new Hono()

app.use('*', logger())
app.use('*', cors())
app.use('*', extractAuth)

// Auth routes
app.route('/api/auth', auth)

// Database name validation for /api/db/:database routes
app.use('/api/db/:database/*', async (c, next) => {
  const database = c.req.param('database')
  const err = validateDatabaseName(database)
  if (err) return c.json({ error: err }, 400)
  return next()
})
app.use('/api/db/:database', async (c, next) => {
  const database = c.req.param('database')
  const err = validateDatabaseName(database)
  if (err) return c.json({ error: err }, 400)
  return next()
})

// Storage routes (file uploads/downloads)
app.route('/api', storageRoutes)

// Rules API routes (admin-only)
app.route('/api', rulesRoutes)

// Legacy permission routes (SDK compat)
app.route('/api', legacyPermissionRoutes)
app.route('/api/db/:database', dbLegacyPermissionRoutes)

// Collection routes (legacy default db + database-aware)
app.route('/api', legacyRoutes)
app.route('/api/db/:database', dbRoutes)

// Admin routes (health, databases list, database delete)
app.route('/api', adminRoutes)

app.onError((err, c) => {
  console.error(err)
  return c.json({ error: 'Internal server error' }, 500)
})

const port = parseInt(process.env.PORT || '8080')

initConfig()

// Migration must run before init (which creates db_default)
await migrateToSchemas()
await loadRules()
watchRules()
await Promise.all([init(), initPubSub(), initAuth()])

console.log(`ezbase running on :${port}`)

export default {
  port,
  fetch: app.fetch,
}
