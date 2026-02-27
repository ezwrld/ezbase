import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { init } from './db.js'
import { initPubSub } from './pubsub.js'
import { initConfig } from './config.js'
import { extractAuth } from './middleware.js'
import { api } from './routes.js'
import { auth } from './auth.js'
import { permissions } from './permissions.js'

const app = new Hono()

app.use('*', logger())
app.use('*', cors())
app.use('*', extractAuth)
app.route('/api/auth', auth)
app.route('/api', permissions)
app.route('/api', api)

app.onError((err, c) => {
  console.error(err)
  return c.json({ error: err.message }, 500)
})

const port = parseInt(process.env.PORT || '8080')

initConfig()
await Promise.all([init(), initPubSub()])

console.log(`ezbase running on :${port}`)

export default {
  port,
  fetch: app.fetch,
}
