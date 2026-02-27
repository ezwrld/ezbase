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

export function qualifiedConfig(database: string) {
  return sql(`db_${database}._ezbase_config`)
}

// ── Database (schema) management ────────────────────────────
export async function ensureDatabase(name: string) {
  const err = validateDatabaseName(name)
  if (err) throw new Error(err)

  if (ensuredDatabases.has(name)) return

  const schema = sql(`db_${name}`)
  await sql`CREATE SCHEMA IF NOT EXISTS ${schema}`
  await sql`
    CREATE TABLE IF NOT EXISTS ${qualifiedConfig(name)} (
      collection TEXT PRIMARY KEY,
      level TEXT NOT NULL DEFAULT 'public'
    )
  `

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

  const hasConfig = await sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = '_ezbase_config'
  `

  if (publicTables.length === 0 && hasConfig.length === 0) return

  console.log(`migrating ${publicTables.length} collection(s) to db_default schema...`)

  // Ensure the db_default schema exists
  await sql`CREATE SCHEMA IF NOT EXISTS db_default`

  // Move _ezbase_config first
  if (hasConfig.length > 0) {
    // Check if db_default already has _ezbase_config
    const destConfig = await sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'db_default' AND table_name = '_ezbase_config'
    `
    if (destConfig.length === 0) {
      await sql`ALTER TABLE public._ezbase_config SET SCHEMA db_default`
      console.log('  moved _ezbase_config → db_default')
    } else {
      // Merge rows then drop old table
      await sql`
        INSERT INTO db_default._ezbase_config (collection, level)
        SELECT collection, level FROM public._ezbase_config
        ON CONFLICT (collection) DO NOTHING
      `
      await sql`DROP TABLE public._ezbase_config`
      console.log('  merged _ezbase_config → db_default (already existed)')
    }
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
}

export { sql }
