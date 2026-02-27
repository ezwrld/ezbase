import postgres from 'postgres'

const sql = postgres(
  process.env.DATABASE_URL ||
    'postgresql://ezbase:ezbase@localhost:5432/ezbase'
)

export async function init() {
  await sql`
    CREATE TABLE IF NOT EXISTS documents (
      collection TEXT NOT NULL,
      id TEXT NOT NULL,
      body JSONB NOT NULL DEFAULT '{}',
      created BIGINT NOT NULL,
      updated BIGINT NOT NULL,
      PRIMARY KEY (collection, id)
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_documents_collection ON documents (collection)`
  await sql`CREATE INDEX IF NOT EXISTS idx_documents_body ON documents USING GIN (body)`
  await sql`CREATE INDEX IF NOT EXISTS idx_documents_created ON documents (collection, created)`

  await sql`
    CREATE TABLE IF NOT EXISTS _ezbase_users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      created BIGINT NOT NULL,
      updated BIGINT NOT NULL
    )
  `

  await sql`
    CREATE TABLE IF NOT EXISTS _ezbase_config (
      collection TEXT PRIMARY KEY,
      level TEXT NOT NULL DEFAULT 'public'
    )
  `
}

export { sql }
