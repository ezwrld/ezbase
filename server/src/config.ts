import crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

let adminKey: string

export function getAdminKey(): string {
  return adminKey
}

export function initConfig() {
  adminKey = process.env.ADMIN_KEY || crypto.randomBytes(32).toString('hex')

  if (!process.env.ADMIN_KEY) {
    console.log(`Generated ADMIN_KEY: ${adminKey}`)
  }
}

/**
 * Auto-generate and persist the BetterAuth session signing secret.
 * - Reads BETTER_AUTH_SECRET env var first (explicit always wins)
 * - Falls back to persisted secret at {STORAGE_PATH}/.auth_secret
 * - If neither exists, generates a random 32-byte base64 string, writes to disk (mode 0600)
 */
export function getAuthSecret(): string {
  if (process.env.BETTER_AUTH_SECRET) {
    return process.env.BETTER_AUTH_SECRET
  }

  const storagePath = process.env.STORAGE_PATH || '/data/files'
  const secretPath = path.join(storagePath, '.auth_secret')

  try {
    const existing = fs.readFileSync(secretPath, 'utf-8').trim()
    if (existing) return existing
  } catch {}

  const secret = crypto.randomBytes(32).toString('base64')

  try {
    fs.mkdirSync(storagePath, { recursive: true })
    fs.writeFileSync(secretPath, secret, { mode: 0o600 })
    console.log('ezbase: generated and persisted auth secret')
  } catch (err) {
    console.warn('ezbase: could not persist auth secret to disk, using ephemeral secret')
  }

  return secret
}
