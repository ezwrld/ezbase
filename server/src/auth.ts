import { Hono } from 'hono'
import { betterAuth } from 'better-auth'
import { bearer } from 'better-auth/plugins'
import { getMigrations } from 'better-auth/db/migration'
import pg from 'pg'
import { sql } from './db.js'
import { getAuthSecret } from './config.js'
import { generateId } from './id.js'
import { sendMail, isMailConfigured } from './mail.js'
import {
  applyPut,
  getEffectiveAuth,
  isAuthSettingsReadonly,
  toView,
  writeAuthFile,
  type AuthSettingsPut,
  type EffectiveAuth,
  type ProviderId,
} from './auth-settings.js'

// pg.Pool is only here because BetterAuth requires it.
// All other queries use the postgres.js `sql` instance from db.ts.
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://ezbase:ezbase@localhost:5432/ezbase',
})

const rateLimitEnabled = process.env.EZBASE_RATE_LIMIT !== 'false'

const requireEmailVerification = process.env.EZBASE_REQUIRE_EMAIL_VERIFICATION === 'true'
if (requireEmailVerification && !isMailConfigured()) {
  console.warn('ezbase: EZBASE_REQUIRE_EMAIL_VERIFICATION is on but SMTP is not configured — verification links will only appear in server logs')
}

async function deliverAuthEmail(kind: string, to: string, subject: string, url: string) {
  if (isMailConfigured()) {
    try {
      await sendMail({ to, subject, text: `${subject}:\n\n${url}\n\nIf you didn't request this, ignore this email.` })
      return
    } catch (err) {
      console.error(`ezbase: failed to send ${kind} email to ${to}:`, err)
    }
  }
  console.log(`ezbase: ${kind} link for ${to}: ${url}`)
}

function parsePublicUrl(raw: string): { origin: string; basePath: string } {
  const parsed = new URL(raw)
  const basePath = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '')
  return { origin: parsed.origin, basePath }
}

function socialFrom(cfg: EffectiveAuth): Record<string, { clientId: string; clientSecret: string }> {
  const out: Record<string, { clientId: string; clientSecret: string }> = {}
  for (const [id, p] of Object.entries(cfg.providers) as [ProviderId, EffectiveAuth['providers'][ProviderId]][]) {
    if (p.enabled && p.clientId && p.clientSecret) {
      out[id] = { clientId: p.clientId, clientSecret: p.clientSecret }
    }
  }
  return out
}

function buildAuthOptions(cfg: EffectiveAuth) {
  const { origin, basePath } = parsePublicUrl(cfg.publicUrl)
  return {
    baseURL: origin,
    basePath: `${basePath}/api/auth`,
    database: pool,
    secret: getAuthSecret(),
    trustedOrigins: cfg.trustedOrigins,
    rateLimit: { enabled: rateLimitEnabled },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      requireEmailVerification,
      sendResetPassword: async ({ user, url }: { user: { email: string }; url: string }) => {
        await deliverAuthEmail('password-reset', user.email, 'Reset your password', url)
      },
    },
    emailVerification: {
      sendOnSignUp: requireEmailVerification,
      sendVerificationEmail: async ({ user, url }: { user: { email: string }; url: string }) => {
        await deliverAuthEmail('email-verification', user.email, 'Verify your email', url)
      },
    },
    session: { expiresIn: 7 * 24 * 60 * 60 },
    plugins: [bearer()],
    socialProviders: socialFrom(cfg),
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: ['google', 'github', 'apple', 'microsoft'],
      },
    },
    user: {
      additionalFields: {
        role: {
          type: 'string' as const,
          defaultValue: 'user',
          input: false,
        },
        claims: {
          type: 'string' as const,
          defaultValue: '{}',
          input: false,
        },
      },
    },
  }
}

export let ba = betterAuth(buildAuthOptions(getEffectiveAuth()))

export function rebuildAuth() {
  ba = betterAuth(buildAuthOptions(getEffectiveAuth()))
  const enabled = Object.keys(socialFrom(getEffectiveAuth()))
  console.log(`ezbase: auth reloaded (providers: ${enabled.length ? enabled.join(', ') : 'email-only'})`)
}

export async function initAuth() {
  const { runMigrations } = await getMigrations(buildAuthOptions(getEffectiveAuth()))
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
  const providers = Object.keys(socialFrom(getEffectiveAuth()))
  return c.json({ providers, emailPassword: true })
})

// ── GET /settings — console auth page (admin) ──────────────
auth.get('/settings', (c) => {
  const denied = requireAdmin(c)
  if (denied) return denied
  return c.json(toView(getEffectiveAuth()))
})

// ── PUT /settings — save providers / public URL (admin) ────
auth.put('/settings', async (c) => {
  const denied = requireAdmin(c)
  if (denied) return denied
  if (isAuthSettingsReadonly()) {
    return c.json({ error: 'auth.json is read-only' }, 409)
  }

  let body: AuthSettingsPut
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400)
  }

  if (body.publicUrl) {
    try {
      new URL(body.publicUrl)
    } catch {
      return c.json({ error: 'publicUrl must be a valid URL (include https:// and /ez if you mount there)' }, 400)
    }
  }

  try {
    const next = applyPut(body)
    writeAuthFile(next)
    rebuildAuth()
    return c.json(toView(getEffectiveAuth()))
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to save' }, 400)
  }
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

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean)
  if (typeof value === 'string') {
    return value.replace(/^{|}$/g, '').split(',').map((s) => s.trim()).filter(Boolean)
  }
  return []
}

function ms(value: unknown): number | null {
  if (value == null) return null
  const n = value instanceof Date ? value.getTime() : new Date(value as string).getTime()
  return Number.isNaN(n) ? null : n
}

function mapProviderId(id: string): string {
  return id === 'credential' ? 'password' : id
}

function formatUser(row: Record<string, unknown>) {
  return {
    id: row.id,
    email: row.email,
    name: row.name || null,
    image: row.image || null,
    role: row.role || 'user',
    claims: parseClaims(row.claims as string),
    providers: asStringArray(row.providers).map(mapProviderId),
    created: ms(row.createdAt),
    lastLogin: ms(row.lastLogin),
    updated: ms(row.updatedAt),
  }
}

function usersFrom(rows: Record<string, unknown>[]) {
  return rows.map(formatUser)
}

async function selectUsers(id?: string, limit = 1, offset = 0) {
  if (id) {
    return sql`
      SELECT
        u.id, u.email, u.name, u.image, u.role, u.claims, u."createdAt", u."updatedAt",
        COALESCE(
          (SELECT array_agg(DISTINCT a."providerId") FROM public."account" a WHERE a."userId" = u.id),
          '{}'::text[]
        ) AS providers,
        (SELECT MAX(s."createdAt") FROM public."session" s WHERE s."userId" = u.id) AS "lastLogin"
      FROM public."user" u
      WHERE u.id = ${id}
    `
  }
  return sql`
    SELECT
      u.id, u.email, u.name, u.image, u.role, u.claims, u."createdAt", u."updatedAt",
      COALESCE(
        (SELECT array_agg(DISTINCT a."providerId") FROM public."account" a WHERE a."userId" = u.id),
        '{}'::text[]
      ) AS providers,
      (SELECT MAX(s."createdAt") FROM public."session" s WHERE s."userId" = u.id) AS "lastLogin"
    FROM public."user" u
    ORDER BY u."createdAt" DESC
    LIMIT ${limit} OFFSET ${offset}
  `
}

async function fetchFormattedUser(id: string) {
  const rows = await selectUsers(id)
  return rows.length === 0 ? null : formatUser(rows[0])
}

// ── GET /users — list users (admin only) ────────────────────
auth.get('/users', async (c) => {
  const denied = requireAdmin(c)
  if (denied) return denied

  const limit = Math.min(parseInt(c.req.query('limit') || '100', 10), 1000)
  const offset = parseInt(c.req.query('offset') || '0', 10)

  const rows = await selectUsers(undefined, limit, offset)
  return c.json(usersFrom(rows))
})

// ── GET /users/:id — get user (admin only) ──────────────────
auth.get('/users/:id', async (c) => {
  const denied = requireAdmin(c)
  if (denied) return denied

  const user = await fetchFormattedUser(c.req.param('id'))
  if (!user) return c.json({ error: 'User not found' }, 404)
  return c.json(user)
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

  const rows = await sql`UPDATE public."user" SET role = ${role} WHERE id = ${id} RETURNING id`
  if (rows.length === 0) return c.json({ error: 'User not found' }, 404)
  return c.json(await fetchFormattedUser(id))
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

  const rows = await sql`UPDATE public."user" SET claims = ${JSON.stringify(claims)} WHERE id = ${id} RETURNING id`
  if (rows.length === 0) return c.json({ error: 'User not found' }, 404)
  return c.json(await fetchFormattedUser(id))
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

  const current = await sql`SELECT claims FROM public."user" WHERE id = ${id}`
  if (current.length === 0) return c.json({ error: 'User not found' }, 404)

  const existing = parseClaims(current[0].claims as string)
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) {
      delete existing[k]
    } else {
      existing[k] = v
    }
  }

  await sql`UPDATE public."user" SET claims = ${JSON.stringify(existing)} WHERE id = ${id}`
  return c.json(await fetchFormattedUser(id))
})

// ── PUT /users/:id/password — set password (admin only) ─────
auth.put('/users/:id/password', async (c) => {
  const denied = requireAdmin(c)
  if (denied) return denied

  const id = c.req.param('id')
  const { password } = await c.req.json()
  if (typeof password !== 'string' || password.length < 8) {
    return c.json({ error: 'password is required (min 8 characters)' }, 400)
  }

  const users = await sql`SELECT id FROM public."user" WHERE id = ${id}`
  if (users.length === 0) return c.json({ error: 'User not found' }, 404)

  const ctx = await ba.$context
  const hash = await ctx.password.hash(password)

  const existing = await sql`
    SELECT id FROM public."account" WHERE "userId" = ${id} AND "providerId" = 'credential'
  `
  if (existing.length > 0) {
    await sql`UPDATE public."account" SET password = ${hash}, "updatedAt" = NOW() WHERE id = ${existing[0].id}`
  } else {
    await sql`
      INSERT INTO public."account" (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
      VALUES (${generateId()}, ${id}, 'credential', ${id}, ${hash}, NOW(), NOW())
    `
  }

  await sql`DELETE FROM public."session" WHERE "userId" = ${id}`

  return c.json({ success: true })
})

// ── DELETE /users/:id — delete user (admin only) ────────────
auth.delete('/users/:id', async (c) => {
  const denied = requireAdmin(c)
  if (denied) return denied

  const id = c.req.param('id')

  const callerUserId = c.get('userId')
  if (callerUserId && callerUserId === id) {
    return c.json({ error: 'Cannot delete your own account' }, 400)
  }

  const userRows = await sql`SELECT id FROM public."user" WHERE id = ${id}`
  if (userRows.length === 0) return c.json({ error: 'User not found' }, 404)

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
