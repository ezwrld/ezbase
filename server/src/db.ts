import { createHash } from 'node:crypto'
import postgres from 'postgres'

const sql = postgres(
  process.env.DATABASE_URL ||
    'postgresql://ezbase:ezbase@localhost:5432/ezbase',
  { max: 50 }
)

const COLLECTION_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,62}$/
const RESERVED_PREFIXES = ['_ezbase_']
const RESERVED_NAMES = ['user', 'session', 'account', 'verification']

const BLOCKED_SCHEMAS = ['public', 'information_schema', 'pg_catalog', 'pg_toast']

const ensured = new Set<string>()
const ensuredDatabases = new Set<string>()

// In-flight creations, deduped so concurrent first-writes share one CREATE.
// Postgres's IF NOT EXISTS does not protect against *concurrent* creation —
// losers of that race get a catalog duplicate-key error (e.g. 23505 on pg_type).
const pendingDatabases = new Map<string, Promise<void>>()
const pendingCollections = new Map<string, Promise<void>>()
const jsonIndexes = new Set<string>()
const pendingJsonIndexes = new Map<string, Promise<void>>()

export type QueryIndexHints = {
  eqFields: string[]
  jsonFields: string[]
  orderField: string | null
}

const IDENT_RE = /^[a-z][a-z0-9_]*$/

export function sqlIndexName(database: string, collection: string, kind: string, parts: string[]): string {
  const raw = ['idx', database, collection, kind, ...parts].join('_').toLowerCase()
  if (raw.length <= 63 && IDENT_RE.test(raw)) return raw
  const h = createHash('sha1')
    .update(`${database}/${collection}/${kind}/${parts.join(',')}`)
    .digest('hex')
    .slice(0, 16)
  return `idx_${h}`
}

export function shouldCreateDataIndex(name: string) {
  const excluded = (process.env.EZBASE_GIN_EXCLUDE || '').split(',').map((value) => value.trim())
  return !excluded.includes(name)
}

function isDuplicateDdlError(err: unknown): boolean {
  const code = (err as { code?: string })?.code
  return code === '23505' || code === '42P07' || code === '42710'
}

async function withDdlRetry(fn: () => Promise<void>) {
  try {
    await fn()
  } catch (err) {
    if (!isDuplicateDdlError(err)) throw err
    // Lost a creation race (concurrent writer from another process) — let the
    // winner's DDL commit, then re-run; IF NOT EXISTS no-ops the second time.
    await new Promise((r) => setTimeout(r, 100))
    await fn()
  }
}

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

/** Check for a database schema without creating it. Positive results are cached. */
export async function databaseExists(name: string): Promise<boolean> {
  const err = validateDatabaseName(name)
  if (err) throw new Error(err)
  if (ensuredDatabases.has(name)) return true

  const rows = await sql`
    SELECT 1 FROM information_schema.schemata
    WHERE schema_name = ${`db_${name}`}
    LIMIT 1
  `
  if (rows.length > 0) ensuredDatabases.add(name)
  return rows.length > 0
}

/** Check for a collection table without creating it. Positive results are cached. */
export async function collectionExists(database: string, name: string): Promise<boolean> {
  const err = validateDatabaseName(database) || validateCollectionName(name)
  if (err) throw new Error(err)

  const cacheKey = `${database}:${name}`
  if (ensured.has(cacheKey)) return true

  const rows = await sql`
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = ${`db_${database}`} AND table_name = ${`col_${name}`}
    LIMIT 1
  `
  if (rows.length > 0) {
    ensuredDatabases.add(database)
    ensured.add(cacheKey)
  }
  return rows.length > 0
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

  let pending = pendingDatabases.get(name)
  if (!pending) {
    pending = withDdlRetry(async () => {
      const schema = sql(`db_${name}`)
      await sql`CREATE SCHEMA IF NOT EXISTS ${schema}`
      ensuredDatabases.add(name)
    }).finally(() => pendingDatabases.delete(name))
    pendingDatabases.set(name, pending)
  }
  return pending
}

// ── Collection management ───────────────────────────────────
export async function ensureCollection(database: string, name: string) {
  const err = validateCollectionName(name)
  if (err) throw new Error(err)

  const cacheKey = `${database}:${name}`
  if (ensured.has(cacheKey)) return

  let pending = pendingCollections.get(cacheKey)
  if (!pending) {
    pending = withDdlRetry(async () => {
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
      if (shouldCreateDataIndex(name)) {
        await sql`CREATE INDEX IF NOT EXISTS ${sql(`idx_${database}_${name}_data`)} ON ${table} USING GIN (data jsonb_path_ops)`
      }
      await sql`CREATE INDEX IF NOT EXISTS ${sql(`idx_${database}_${name}_created`)} ON ${table} (created_at)`
      await sql`CREATE INDEX IF NOT EXISTS ${sql(`idx_${database}_${name}_updated`)} ON ${table} (updated_at)`

      ensured.add(cacheKey)
    }).finally(() => pendingCollections.delete(cacheKey))
    pendingCollections.set(cacheKey, pending)
  }
  return pending
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
  for (const key of [...jsonIndexes]) {
    if (key.includes(`_${database}_`) || key.startsWith(`idx_${database}_`)) {
      jsonIndexes.delete(key)
    }
  }
}

function jsonExpr(field: string): string {
  return `(data->'${field}')`
}

async function createIndexOnce(name: string, ddl: string) {
  if (jsonIndexes.has(name)) return
  let pending = pendingJsonIndexes.get(name)
  if (!pending) {
    pending = (async () => {
      try {
        await withDdlRetry(async () => {
          const t0 = Date.now()
          await sql.unsafe(ddl)
          const ms = Date.now() - t0
          if (ms >= 100) console.log(`  created index ${name} in ${ms}ms`)
        })
      } catch (err) {
        console.error(`failed to create index ${name}:`, err)
      } finally {
        jsonIndexes.add(name)
      }
    })().finally(() => pendingJsonIndexes.delete(name))
    pendingJsonIndexes.set(name, pending)
  }
  await pending
}

/**
 * Firestore-style: btree on JSON fields the query actually uses, plus a
 * composite of equality filters + orderBy so `where status==pending orderBy
 * observedAt limit 25` is an index scan instead of GIN + sort.
 */
export async function ensureQueryIndexes(
  database: string,
  collection: string,
  hints: QueryIndexHints
) {
  const err = validateCollectionName(collection) || validateDatabaseName(database)
  if (err) throw new Error(err)

  await ensureCollection(database, collection)
  const table = `db_${database}.col_${collection}`

  for (const field of hints.jsonFields) {
    const name = sqlIndexName(database, collection, 'j', [field])
    const expr = jsonExpr(field)
    await createIndexOnce(
      name,
      `CREATE INDEX IF NOT EXISTS ${name} ON ${table} (${expr}) WHERE ${expr} IS NOT NULL`
    )
  }

  const orderField = hints.orderField
  const eq = hints.eqFields.slice(0, 3)
  if (eq.length === 0 || !orderField) return

  const parts = [...eq]
  let extra = ''
  if (orderField === 'created_at' || orderField === 'updated_at') {
    extra = `, ${orderField}`
  } else if (!eq.includes(orderField)) {
    parts.push(orderField)
  }
  if (parts.length === 1 && !extra) return

  const name = sqlIndexName(
    database,
    collection,
    'c',
    extra ? [...parts, orderField] : parts
  )
  const cols = parts.map(jsonExpr).join(', ') + extra
  const partial = eq.length > 0 ? ` WHERE ${jsonExpr(eq[0])} IS NOT NULL` : ''
  await createIndexOnce(name, `CREATE INDEX IF NOT EXISTS ${name} ON ${table} (${cols})${partial}`)
}

export async function ensureTimestampIndexes() {
  const tables = await sql`
    SELECT n.nspname AS schema, c.relname AS relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname LIKE 'db\_%' ESCAPE '\'
      AND c.relname LIKE 'col\_%' ESCAPE '\'
      AND c.relkind = 'r'
  `
  for (const row of tables) {
    const database = String(row.schema).slice(3)
    const collection = String(row.relname).slice(4)
    if (validateDatabaseName(database) || validateCollectionName(collection)) continue
    const table = qualifiedTable(database, collection)
    await sql`CREATE INDEX IF NOT EXISTS ${sql(`idx_${database}_${collection}_created`)} ON ${table} (created_at)`
    await sql`CREATE INDEX IF NOT EXISTS ${sql(`idx_${database}_${collection}_updated`)} ON ${table} (updated_at)`
  }
}

// ── Init ────────────────────────────────────────────────────
export async function init() {
  // BetterAuth manages user/session tables in public schema automatically
  await ensureDatabase('default')
  await ensureTimestampIndexes()

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
