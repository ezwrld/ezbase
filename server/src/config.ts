import crypto from 'node:crypto'

let adminKey: string
let jwtSecret: string

export function getAdminKey(): string {
  return adminKey
}

export function getJwtSecret(): string {
  return jwtSecret
}

export function initConfig() {
  adminKey = process.env.ADMIN_KEY || crypto.randomBytes(32).toString('hex')
  jwtSecret = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex')

  if (!process.env.ADMIN_KEY) {
    console.log(`Generated ADMIN_KEY: ${adminKey}`)
  }
  if (!process.env.JWT_SECRET) {
    console.log(`Generated JWT_SECRET (set JWT_SECRET env to persist across restarts)`)
  }
}
