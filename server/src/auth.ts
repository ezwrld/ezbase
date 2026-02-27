import { Hono } from 'hono'
import { betterAuth } from 'better-auth'
import { bearer } from 'better-auth/plugins'
import { getMigrations } from 'better-auth/db'
import pg from 'pg'

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://ezbase:ezbase@localhost:5432/ezbase',
})

const authOptions = {
  database: pool,
  secret: process.env.BETTER_AUTH_SECRET,
  emailAndPassword: { enabled: true, minPasswordLength: 8 },
  session: { expiresIn: 7 * 24 * 60 * 60 },
  plugins: [bearer()],
}

export const ba = betterAuth(authOptions)

export async function initAuth() {
  const { runMigrations } = await getMigrations(authOptions)
  await runMigrations()
}

const auth = new Hono()

// ── GET /me — custom handler (admin key support) ────────────
auth.get('/me', async (c) => {
  const role = c.get('role') || 'anonymous'

  if (role === 'admin') {
    return c.json({ id: 'admin', email: null, role: 'admin' })
  }

  const userId = c.get('userId')
  if (!userId || role === 'anonymous') {
    return c.json({ error: 'Not authenticated' }, 401)
  }

  // Look up user from BetterAuth's session context
  const session = await getSessionFromRequest(c.req.raw)
  if (!session) {
    return c.json({ error: 'Not authenticated' }, 401)
  }

  return c.json({
    id: session.user.id,
    email: session.user.email,
    role: session.user.role || 'user',
  })
})

// ── BetterAuth catch-all ────────────────────────────────────
auth.on(['POST', 'GET'], '/*', (c) => ba.handler(c.req.raw))

async function getSessionFromRequest(req: Request): Promise<any> {
  try {
    return await ba.api.getSession({ headers: req.headers })
  } catch {
    return null
  }
}

export { auth }
