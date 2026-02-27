import postgres from 'postgres'

const sql = postgres(
  process.env.DATABASE_URL ||
    'postgresql://ezbase:ezbase@localhost:5432/ezbase'
)

const COLLECTION_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,62}$/
const RESERVED_PREFIXES = ['_ezbase_']
const RESERVED_NAMES = ['user', 'session', 'account', 'verification']

const ensured = new Set<string>()

export function validateCollectionName(name: string): string | null {
  if (!COLLECTION_RE.test(name)) {
    return 'Collection name must start with a letter and contain only letters, numbers, and underscores (max 63 chars)'
  }
  if (RESERVED_PREFIXES.some((p) => name.startsWith(p))) {
    return 'Collection names starting with _ezbase_ are reserved'
  }
  if (RESERVED_NAMES.includes(name.toLowerCase())) {
    return `Collection name "${name}" is reserved`
  }
  return null
}

export async function ensureCollection(name: string) {
  const err = validateCollectionName(name)
  if (err) throw new Error(err)

  if (ensured.has(name)) return

  const table = sql(`col_${name}`)
  await sql`
    CREATE TABLE IF NOT EXISTS ${table} (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL DEFAULT '{}',
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS ${sql(`idx_${name}_data`)} ON ${table} USING GIN (data)`
  await sql`CREATE INDEX IF NOT EXISTS ${sql(`idx_${name}_created`)} ON ${table} (created_at)`

  ensured.add(name)
}

export async function init() {
  // BetterAuth manages user/session tables automatically
  await sql`
    CREATE TABLE IF NOT EXISTS _ezbase_config (
      collection TEXT PRIMARY KEY,
      level TEXT NOT NULL DEFAULT 'public'
    )
  `
}

export { sql }
