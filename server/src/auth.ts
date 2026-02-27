import { Hono } from 'hono'
import { sign } from 'hono/jwt'
import bcrypt from 'bcryptjs'
import { sql } from './db.js'
import { generateId } from './id.js'
import { getJwtSecret } from './config.js'

const auth = new Hono()

const SEVEN_DAYS = 7 * 24 * 60 * 60

function sanitizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

// ── POST /signup ────────────────────────────────────────────
auth.post('/signup', async (c) => {
  const { email, password } = await c.req.json()

  if (!email || !password) {
    return c.json({ error: 'Email and password are required' }, 400)
  }

  const cleanEmail = sanitizeEmail(email)
  if (typeof password !== 'string' || password.length < 8) {
    return c.json({ error: 'Password must be at least 8 characters' }, 400)
  }

  // Check for existing user
  const existing = await sql`
    SELECT id FROM _ezbase_users WHERE email = ${cleanEmail}
  `
  if (existing.length > 0) {
    return c.json({ error: 'Email already registered' }, 409)
  }

  const id = generateId()
  const now = Date.now()
  const passwordHash = await bcrypt.hash(password, 10)

  await sql`
    INSERT INTO _ezbase_users (id, email, password_hash, role, created, updated)
    VALUES (${id}, ${cleanEmail}, ${passwordHash}, 'user', ${now}, ${now})
  `

  const nowSec = Math.floor(now / 1000)
  const token = await sign(
    { sub: id, email: cleanEmail, role: 'user', iat: nowSec, exp: nowSec + SEVEN_DAYS },
    getJwtSecret()
  )

  return c.json({
    token,
    user: { id, email: cleanEmail, role: 'user', created: now, updated: now },
  }, 201)
})

// ── POST /signin ────────────────────────────────────────────
auth.post('/signin', async (c) => {
  const { email, password } = await c.req.json()

  if (!email || !password) {
    return c.json({ error: 'Email and password are required' }, 400)
  }

  const cleanEmail = sanitizeEmail(email)

  const rows = await sql`
    SELECT * FROM _ezbase_users WHERE email = ${cleanEmail}
  `
  if (rows.length === 0) {
    return c.json({ error: 'Invalid email or password' }, 401)
  }

  const user = rows[0]
  const valid = await bcrypt.compare(password, user.password_hash as string)
  if (!valid) {
    return c.json({ error: 'Invalid email or password' }, 401)
  }

  const nowSec = Math.floor(Date.now() / 1000)
  const token = await sign(
    { sub: user.id, email: user.email, role: user.role, iat: nowSec, exp: nowSec + SEVEN_DAYS },
    getJwtSecret()
  )

  return c.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      created: Number(user.created),
      updated: Number(user.updated),
    },
  })
})

// ── GET /me ─────────────────────────────────────────────────
auth.get('/me', async (c) => {
  const role = c.get('role') || 'anonymous'

  if (role === 'admin') {
    return c.json({ id: 'admin', email: null, role: 'admin' })
  }

  const userId = c.get('userId')
  if (!userId || role === 'anonymous') {
    return c.json({ error: 'Not authenticated' }, 401)
  }

  const rows = await sql`
    SELECT id, email, role, created, updated FROM _ezbase_users WHERE id = ${userId}
  `
  if (rows.length === 0) {
    return c.json({ error: 'User not found' }, 404)
  }

  const user = rows[0]
  return c.json({
    id: user.id,
    email: user.email,
    role: user.role,
    created: Number(user.created),
    updated: Number(user.updated),
  })
})

export { auth }
