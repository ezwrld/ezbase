import { Hono } from 'hono'
import { betterAuth } from 'better-auth'
import { bearer } from 'better-auth/plugins'
import { getMigrations } from 'better-auth/db/migration'
import pg from 'pg'
import { sql } from './db.js'
import { getAuthSecret, getPublicUrl } from './config.js'

// pg.Pool is only here because BetterAuth requires it.
// All other queries use the postgres.js `sql` instance from db.ts.
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://ezbase:ezbase@localhost:5432/ezbase',
})

const socialProviders: Record<string, { clientId: string; clientSecret: string }> = {}

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  socialProviders.google = {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  }
}
if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
  socialProviders.github = {
    clientId: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
  }
}
if (process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET) {
  socialProviders.microsoft = {
    clientId: process.env.MICROSOFT_CLIENT_ID,
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
  }
}
if (process.env.APPLE_CLIENT_ID && process.env.APPLE_CLIENT_SECRET) {
  socialProviders.apple = {
    clientId: process.env.APPLE_CLIENT_ID,
    clientSecret: process.env.APPLE_CLIENT_SECRET,
  }
}

const { origin: publicOrigin, basePath: publicBasePath } = getPublicUrl()

const authOptions = {
  baseURL: publicOrigin,
  basePath: `${publicBasePath}/api/auth`,
  database: pool,
  secret: getAuthSecret(),
  emailAndPassword: { enabled: true, minPasswordLength: 8 },
  session: { expiresIn: 7 * 24 * 60 * 60 },
  plugins: [bearer()],
  socialProviders,
  account: {
    accountLinking: {
      enabled: true,
      trustedProviders: ['google', 'github', 'apple', 'microsoft'],
    },
  },
  user: {
    additionalFields: {
      role: {
        type: "string" as const,
        defaultValue: "user",
        input: false,
      },
      claims: {
        type: "string" as const,
        defaultValue: "{}",
        input: false,
      },
    },
  },
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
    return c.json({ id: 'admin', email: null, role: 'admin', claims: {} })
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

  let claims: Record<string, unknown> = {}
  try { claims = JSON.parse(session.user.claims || '{}') } catch {}

  return c.json({
    id: session.user.id,
    email: session.user.email,
    role: session.user.role || 'user',
    claims,
  })
})

// ── GET /providers — list enabled OAuth providers ──────────
auth.get('/providers', (c) => {
  const providers = Object.keys(socialProviders)
  return c.json({ providers, emailPassword: true })
})

// ── Helper: require admin role ──────────────────────────────
function requireAdmin(c: any): Response | null {
  const role = c.get('role') || 'anonymous'
  if (role === 'admin') return null
  if (role === 'anonymous') return c.json({ error: 'Unauthorized' }, 401)
  return c.json({ error: 'Forbidden' }, 403)
}

function parseClaims(raw: string | null | undefined): Record<string, unknown> {
  try { return JSON.parse(raw || '{}') } catch { return {} }
}

function formatUser(row: Record<string, unknown>) {
  return {
    id: row.id,
    email: row.email,
    name: row.name || null,
    image: row.image || null,
    role: row.role || 'user',
    claims: parseClaims(row.claims as string),
    created: row.createdAt ? new Date(row.createdAt as string).getTime() : null,
    updated: row.updatedAt ? new Date(row.updatedAt as string).getTime() : null,
  }
}

// ── GET /users — list users (admin only) ────────────────────
auth.get('/users', async (c) => {
  const denied = requireAdmin(c)
  if (denied) return denied

  const limit = Math.min(parseInt(c.req.query('limit') || '100', 10), 1000)
  const offset = parseInt(c.req.query('offset') || '0', 10)

  const rows = await sql`SELECT * FROM public."user" ORDER BY "createdAt" DESC LIMIT ${limit} OFFSET ${offset}`
  return c.json(rows.map(formatUser))
})

// ── GET /users/:id — get user (admin only) ──────────────────
auth.get('/users/:id', async (c) => {
  const denied = requireAdmin(c)
  if (denied) return denied

  const id = c.req.param('id')
  const rows = await sql`SELECT * FROM public."user" WHERE id = ${id}`
  if (rows.length === 0) return c.json({ error: 'User not found' }, 404)
  return c.json(formatUser(rows[0]))
})

// ── PUT /users/:id/role — set role (admin only) ─────────────
auth.put('/users/:id/role', async (c) => {
  const denied = requireAdmin(c)
  if (denied) return denied

  const id = c.req.param('id')
  const { role } = await c.req.json()
  if (!role || typeof role !== 'string') {
    return c.json({ error: 'role is required and must be a string' }, 400)
  }

  const rows = await sql`UPDATE public."user" SET role = ${role} WHERE id = ${id} RETURNING *`
  if (rows.length === 0) return c.json({ error: 'User not found' }, 404)
  return c.json(formatUser(rows[0]))
})

// ── PUT /users/:id/claims — replace claims (admin only) ─────
auth.put('/users/:id/claims', async (c) => {
  const denied = requireAdmin(c)
  if (denied) return denied

  const id = c.req.param('id')
  const claims = await c.req.json()
  if (typeof claims !== 'object' || claims === null || Array.isArray(claims)) {
    return c.json({ error: 'Body must be a JSON object' }, 400)
  }

  const rows = await sql`UPDATE public."user" SET claims = ${JSON.stringify(claims)} WHERE id = ${id} RETURNING *`
  if (rows.length === 0) return c.json({ error: 'User not found' }, 404)
  return c.json(formatUser(rows[0]))
})

// ── PATCH /users/:id/claims — merge claims (admin only) ─────
auth.patch('/users/:id/claims', async (c) => {
  const denied = requireAdmin(c)
  if (denied) return denied

  const id = c.req.param('id')
  const patch = await c.req.json()
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    return c.json({ error: 'Body must be a JSON object' }, 400)
  }

  // Fetch current claims
  const current = await sql`SELECT claims FROM public."user" WHERE id = ${id}`
  if (current.length === 0) return c.json({ error: 'User not found' }, 404)

  const existing = parseClaims(current[0].claims as string)
  // Merge: null values delete keys
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) {
      delete existing[k]
    } else {
      existing[k] = v
    }
  }

  const rows = await sql`UPDATE public."user" SET claims = ${JSON.stringify(existing)} WHERE id = ${id} RETURNING *`
  return c.json(formatUser(rows[0]))
})

// ── DELETE /users/:id — delete user (admin only) ────────────
auth.delete('/users/:id', async (c) => {
  const denied = requireAdmin(c)
  if (denied) return denied

  const id = c.req.param('id')

  // Self-deletion guard
  const callerUserId = c.get('userId')
  if (callerUserId && callerUserId === id) {
    return c.json({ error: 'Cannot delete your own account' }, 400)
  }

  // Check user exists
  const userRows = await sql`SELECT id FROM public."user" WHERE id = ${id}`
  if (userRows.length === 0) return c.json({ error: 'User not found' }, 404)

  // Delete sessions, accounts, then user
  await sql`DELETE FROM public."session" WHERE "userId" = ${id}`
  await sql`DELETE FROM public."account" WHERE "userId" = ${id}`
  await sql`DELETE FROM public."user" WHERE id = ${id}`

  return c.json({ success: true })
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
