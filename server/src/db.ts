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
const collectionCreatedHooks: Array<(database: string, collection: string) => void> = []

/** Runs after ensureCollection creates a table, e.g. to apply declared indexes. */
export function onCollectionCreated(hook: (database: string, collection: string) => void) {
  collectionCreatedHooks.push(hook)
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

/** Quoted schema for hand-built SQL. Names keep their case (bookingFormVisits), so they must be quoted. */
export function schemaName(database: string): string {
  const err = validateDatabaseName(database)
  if (err) throw new Error(err)
  return `"db_${database}"`
}

/** Quoted table name for hand-built SQL; validates both names since they are interpolated. */
export function qualifiedTableName(database: string, collection: string): string {
  const err = validateCollectionName(collection)
  if (err) throw new Error(err)
  return `${schemaName(database)}."col_${collection}"`
}

const FIELD_PART_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/

/** A document field, optionally a dotted path into nested objects (`stats.rushingYards`). */
export function sanitizeField(field: string): string {
  const parts = typeof field === 'string' ? field.split('.') : []
  if (parts.length === 0 || parts.length > 8 || !parts.every((part) => FIELD_PART_RE.test(part))) {
    throw new Error(`Invalid field name: ${field}`)
  }
  return field
}

/** `data->'a'->'b'` for a sanitized dotted path; query predicates and index expressions must match exactly. */
export function jsonPath(field: string): string {
  return `data${field.split('.').map((part) => `->'${part}'`).join('')}`
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

      ensured.add(cacheKey)
      for (const hook of collectionCreatedHooks) hook(database, name)
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
      await sql.unsafe(`ALTER TABLE public."${tableName}" SET SCHEMA db_default`)
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

function jsonExpr(field: string): string {
  return `(${jsonPath(field)})`
}

export type IndexDefinition = { name: string; columns: string; partial: string | null }

/**
 * The one place an index shape becomes DDL. Names match what earlier versions
 * built per query shape (and per timestamp column), so declaring a shape that
 * already has an index adopts it instead of rebuilding. `order` is a JSON field
 * or the created_at/updated_at column; null for equality-only shapes.
 */
export function indexDefinition(
  database: string,
  collection: string,
  equals: string[],
  order: string | null
): IndexDefinition | null {
  const eq = equals.slice(0, 3)
  const column = order === 'created_at' || order === 'updated_at'
  if (eq.length === 0) {
    if (!order) return null
    if (column) return { name: `idx_${database}_${collection}_${order.slice(0, -3)}`.slice(0, 63), columns: order, partial: null }
    return { name: sqlIndexName(database, collection, 'o', [order]), columns: jsonExpr(order), partial: null }
  }
  const partial = `${jsonExpr(eq[0])} IS NOT NULL`
  const parts = [...eq]
  if (order && !column && !eq.includes(order)) parts.push(order)
  if (parts.length === 1 && !column) {
    return { name: sqlIndexName(database, collection, 'j', parts), columns: jsonExpr(parts[0]), partial }
  }
  return {
    name: sqlIndexName(database, collection, order ? 'c' : 'e', column ? [...parts, order!] : parts),
    columns: parts.map(jsonExpr).join(', ') + (column ? `, ${order}` : ''),
    partial,
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
