import crypto from 'node:crypto'

const CHARS = 'abcdefghjkmnpqrstvwxyz0123456789'

export function generateId(): string {
  const timestamp = Date.now().toString(36)
  const random = Array.from(crypto.randomBytes(8))
    .map((b) => CHARS[b % CHARS.length])
    .join('')
  return `${timestamp}${random}`
}
