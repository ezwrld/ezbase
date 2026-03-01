import postgres from 'postgres'

const sql = postgres(
  process.env.DATABASE_URL ||
    'postgresql://ezbase:ezbase@localhost:5432/ezbase'
)

const COLLECTION_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,62}$/
const RESERVED_PREFIXES = ['_ezbase_']
const RESERVED_NAMES = ['user', 'session', 'account', 'verification']

const BLOCKED_SCHEMAS = ['public', 'information_schema', 'pg_catalog', 'pg_toast']

const ensured = new Set<string>()
const ensuredDatabases = new Set<string>()

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

export function validateDatabaseName(name: string): string | null {
  if (!COLLECTION_RE.test(name)) {
    return 'Database name must start with a letter and contain only letters, numbers, and underscores (max 63 chars)'
  }
  if (RESERVED_PREFIXES.some((p) => name.startsWith(p))) {
    return 'Database names starting with _ezbase_ are reserved'
  }
  if (BLOCKED_SCHEMAS.includes(name.toLowerCase())) {
    return `Database name "${name}" is reserved`
  }
  return null
}

// ── Qualified table helpers ─────────────────────────────────
export function qualifiedTable(database: string, collection: string) {
  return sql(`db_${database}.col_${collection}`)
}

// ── Database (schema) management ────────────────────────────
export async function ensureDatabase(name: string) {
  const err = validateDatabaseName(name)
  if (err) throw new Error(err)

  if (ensuredDatabases.has(name)) return

  const schema = sql(`db_${name}`)
  await sql`CREATE SCHEMA IF NOT EXISTS ${schema}`

  ensuredDatabases.add(name)
}

// ── Collection management ───────────────────────────────────
export async function ensureCollection(database: string, name: string) {
  const err = validateCollectionName(name)
  if (err) throw new Error(err)

  const cacheKey = `${database}:${name}`
  if (ensured.has(cacheKey)) return

  await ensureDatabase(database)

  const table = qualifiedTable(database, name)
  await sql`
    CREATE TABLE IF NOT EXISTS ${table} (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL DEFAULT '{}',
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS ${sql(`idx_${database}_${name}_data`)} ON ${table} USING GIN (data)`
  await sql`CREATE INDEX IF NOT EXISTS ${sql(`idx_${database}_${name}_created`)} ON ${table} (created_at)`

  ensured.add(cacheKey)
}

// ── Migration: move col_* tables from public to db_default ──
export async function migrateToSchemas() {
  // Check if any col_* tables exist in public schema
  const publicTables = await sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name LIKE 'col_%'
    ORDER BY table_name
  `

  if (publicTables.length === 0) return

  console.log(`migrating ${publicTables.length} collection(s) to db_default schema...`)

  // Ensure the db_default schema exists
  await sql`CREATE SCHEMA IF NOT EXISTS db_default`

  // Drop legacy _ezbase_config tables if they exist
  const legacyConfigs = await sql`
    SELECT table_schema FROM information_schema.tables
    WHERE table_name = '_ezbase_config'
  `
  for (const row of legacyConfigs) {
    const schema = row.table_schema as string
    await sql.unsafe(`DROP TABLE IF EXISTS "${schema}"._ezbase_config`)
    console.log(`  dropped legacy _ezbase_config from ${schema}`)
  }

  // Move each col_* table
  for (const row of publicTables) {
    const tableName = row.table_name as string
    // Check if destination already exists
    const dest = await sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'db_default' AND table_name = ${tableName}
    `
    if (dest.length === 0) {
      await sql.unsafe(`ALTER TABLE public.${tableName} SET SCHEMA db_default`)
      console.log(`  moved ${tableName} → db_default`)
    }
  }

  console.log('migration complete')
}

// ── Cache management ────────────────────────────────────────
export function clearDatabaseCaches(database: string) {
  ensuredDatabases.delete(database)
  // Clear all collection entries for this database
  for (const key of ensured) {
    if (key.startsWith(`${database}:`)) {
      ensured.delete(key)
    }
  }
}

// ── Init ────────────────────────────────────────────────────
export async function init() {
  // BetterAuth manages user/session tables in public schema automatically
  await ensureDatabase('default')

  // File storage metadata table (global, in public schema)
  await sql`
    CREATE TABLE IF NOT EXISTS _ezbase_files (
      path        TEXT PRIMARY KEY,
      bucket      TEXT NOT NULL,
      filename    TEXT NOT NULL,
      size        BIGINT NOT NULL,
      mime_type   TEXT NOT NULL,
      uploaded_by TEXT,
      created_at  BIGINT NOT NULL,
      updated_at  BIGINT NOT NULL
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_files_bucket ON _ezbase_files (bucket)`
  await sql`CREATE INDEX IF NOT EXISTS idx_files_uploaded_by ON _ezbase_files (uploaded_by)`
}

export { sql }
