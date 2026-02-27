import crypto from 'node:crypto'

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
