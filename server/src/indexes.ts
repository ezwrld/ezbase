import * as fs from 'node:fs'
import {
  collectionExists,
  indexDefinition,
  onCollectionCreated,
  qualifiedTableName,
  sanitizeField,
  schemaName,
  sql,
  validateCollectionName,
  validateDatabaseName,
  type IndexDefinition,
} from './db.js'
import type { AppliedFilter } from './rules.js'

/**
 * /data/indexes.json is the only source of indexes on collection tables. When the
 * file exists, ezbase builds every declared index concurrently and drops every
 * other non-unique index on every collection, in every database. Queries never
 * run DDL; a query no declared index serves is recorded with its time so the
 * entry that would serve it can be declared.
 *
 *   { "collections": { "player_game_stats": { "indexes": [
 *       { "equals": ["gameId"], "orderedBy": "updated" } ] } } }
 */

export type DeclaredIndex = { equals?: string[]; orderedBy?: string }
export type IndexesFile = { collections: Record<string, { indexes: DeclaredIndex[] }> }

const INDEXES_PATH = process.env.INDEXES_PATH || '/data/indexes.json'
const MAX_EQUALS = 3
const MAX_PER_COLLECTION = 32
const UNSERVED_FLUSH_MS = 15_000
const UNSERVED_RETENTION_MS = 14 * 24 * 60 * 60 * 1000

let declared: IndexesFile = { collections: {} }
let managed = false
let chain: Promise<void> = Promise.resolve()

export function getDeclaredIndexes(): IndexesFile {
  return declared
}

export function validateIndexes(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'indexes.json must be an object'
  const keys = Object.keys(value)
  if (keys.some((key) => key !== 'collections')) return 'indexes.json only takes "collections"'
  const collections = (value as IndexesFile).collections ?? {}
  if (typeof collections !== 'object' || Array.isArray(collections)) return '"collections" must be an object'
  for (const [name, entry] of Object.entries(collections)) {
    const err = validateCollectionName(name)
    if (err) return `${name}: ${err}`
    if (typeof entry !== 'object' || entry === null || !Array.isArray(entry.indexes)) return `${name}: needs "indexes": [...]`
    if (Object.keys(entry).some((key) => key !== 'indexes')) return `${name}: only takes "indexes"`
    if (entry.indexes.length > MAX_PER_COLLECTION) return `${name}: at most ${MAX_PER_COLLECTION} indexes`
    for (const index of entry.indexes) {
      if (typeof index !== 'object' || index === null) return `${name}: each index is an object`
      if (Object.keys(index).some((key) => key !== 'equals' && key !== 'orderedBy')) return `${name}: an index takes "equals" and "orderedBy"`
      const equals = index.equals ?? []
      if (!Array.isArray(equals) || equals.length > MAX_EQUALS) return `${name}: "equals" is a list of at most ${MAX_EQUALS} fields`
      if (equals.length === 0 && !index.orderedBy) return `${name}: an index needs "equals" or "orderedBy"`
      try {
        for (const field of equals) {
          if (field === 'created' || field === 'updated') return `${name}: "${field}" cannot be an equality field`
          sanitizeField(field)
        }
        if (index.orderedBy !== undefined) sanitizeField(index.orderedBy)
      } catch (error) {
        return `${name}: ${(error as Error).message}`
      }
    }
  }
  return null
}

/** The file's contents, or null when it is invalid and the previous declaration stays in force. */
function read(): { file: IndexesFile; present: boolean } | null {
  if (!fs.existsSync(INDEXES_PATH)) return { file: { collections: {} }, present: false }
  const parsed = JSON.parse(fs.readFileSync(INDEXES_PATH, 'utf-8'))
  const err = validateIndexes(parsed)
  if (err) {
    console.warn(`ezbase: indexes.json ignored: ${err}`)
    return null
  }
  return { file: { collections: parsed.collections ?? {} }, present: true }
}

const orderColumn = (orderedBy?: string): string | null =>
  orderedBy === 'created' ? 'created_at' : orderedBy === 'updated' ? 'updated_at' : orderedBy ?? null

const definitionOf = (database: string, collection: string, index: DeclaredIndex) =>
  indexDefinition(database, collection, index.equals ?? [], orderColumn(index.orderedBy))

function definitionsFor(database: string, collection: string): Map<string, IndexDefinition> {
  const wanted = new Map<string, IndexDefinition>()
  for (const index of declared.collections[collection]?.indexes ?? []) {
    const def = definitionOf(database, collection, index)
    if (def) wanted.set(def.name, def)
  }
  return wanted
}

const dropIndex = (database: string, name: string) =>
  sql.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS ${schemaName(database)}."${name}"`)

/** Makes one collection's indexes match indexes.json: build what is declared, then drop the rest. */
async function applyTo(database: string, collection: string) {
  if (!managed || !(await collectionExists(database, collection))) return
  const table = qualifiedTableName(database, collection)
  const wanted = definitionsFor(database, collection)
  const existing = await sql<{ name: string; valid: boolean }[]>`
    SELECT c.relname AS name, i.indisvalid AS valid
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = ${`db_${database}`} AND t.relname = ${`col_${collection}`}
      AND NOT i.indisprimary AND NOT i.indisunique
  `
  const byName = new Map(existing.map((row) => [row.name, row]))

  for (const def of wanted.values()) {
    const row = byName.get(def.name)
    if (row?.valid) continue
    try {
      // An interrupted concurrent build leaves an invalid index that IF NOT EXISTS would keep forever.
      if (row) await dropIndex(database, def.name)
      const t0 = Date.now()
      await sql.unsafe(`CREATE INDEX CONCURRENTLY IF NOT EXISTS "${def.name}" ON ${table} (${def.columns})${def.partial ? ` WHERE ${def.partial}` : ''}`)
      await sql.unsafe(`ANALYZE ${table}`)
      console.log(`ezbase: built ${database}.${def.name} in ${Date.now() - t0}ms`)
    } catch (error) {
      console.error(`ezbase: building ${database}.${def.name} failed:`, error)
      await dropIndex(database, def.name).catch(() => {})
    }
  }

  for (const row of existing) {
    if (wanted.has(row.name)) continue
    try {
      await dropIndex(database, row.name)
      console.log(`ezbase: dropped ${database}.${row.name}, not in indexes.json`)
    } catch (error) {
      console.error(`ezbase: dropping ${database}.${row.name} failed:`, error)
    }
  }
}

async function databases(): Promise<string[]> {
  const rows = await sql<{ name: string }[]>`SELECT nspname AS name FROM pg_namespace WHERE nspname LIKE 'db\\_%' ESCAPE '\\'`
  return rows.map((row) => row.name.slice(3))
}

async function collectionTables(): Promise<{ database: string; collection: string }[]> {
  const rows = await sql<{ schema: string; table: string }[]>`
    SELECT n.nspname AS schema, c.relname AS table
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname LIKE 'db\\_%' ESCAPE '\\' AND c.relname LIKE 'col\\_%' ESCAPE '\\' AND c.relkind = 'r'
    ORDER BY 1, 2
  `
  return rows
    .map((row) => ({ database: row.schema.slice(3), collection: row.table.slice(4) }))
    .filter(({ database, collection }) => !validateDatabaseName(database) && !validateCollectionName(collection))
}

/** Builds and drops to match indexes.json, one index at a time, in the background. */
function apply(target?: { database: string; collection: string }) {
  chain = chain.then(async () => {
    if (!managed) return
    for (const { database, collection } of target ? [target] : await collectionTables()) {
      await applyTo(database, collection)
    }
  }).catch((error) => console.error('ezbase: applying indexes.json failed:', error))
  return chain
}

function setDeclared(next: { file: IndexesFile; present: boolean }) {
  declared = next.file
  managed = next.present
}

export async function loadIndexes() {
  await sql`
    CREATE TABLE IF NOT EXISTS _ezbase_unserved (
      db          TEXT NOT NULL,
      collection  TEXT NOT NULL,
      entry       TEXT NOT NULL,
      queries     BIGINT NOT NULL,
      total_ms    DOUBLE PRECISION NOT NULL,
      last_seen   BIGINT NOT NULL,
      PRIMARY KEY (db, collection, entry)
    )
  `
  setInterval(() => flushUnserved().catch((error) => console.error('ezbase: recording unserved queries failed:', error)), UNSERVED_FLUSH_MS)
  const next = read()
  if (next) setDeclared(next)
  const count = Object.values(declared.collections).reduce((n, c) => n + c.indexes.length, 0)
  console.log(managed ? `ezbase: indexes.json declares ${count} indexes` : 'ezbase: no indexes.json; existing indexes are left as they are')
  onCollectionCreated((database, collection) => {
    if (declared.collections[collection]) apply({ database, collection })
  })
  apply()
}

export function watchIndexes() {
  try {
    let debounce: ReturnType<typeof setTimeout> | null = null
    const dir = INDEXES_PATH.slice(0, INDEXES_PATH.lastIndexOf('/')) || '.'
    const file = INDEXES_PATH.slice(INDEXES_PATH.lastIndexOf('/') + 1)
    fs.watch(dir, (_event, changed) => {
      if (changed !== file) return
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => {
        try {
          const next = read()
          if (!next) return
          setDeclared(next)
          console.log('ezbase: indexes.json reloaded')
          apply()
        } catch (error) {
          console.warn('ezbase: failed to reload indexes.json:', error)
        }
      }, 200)
    })
  } catch {
    // File watching not available — no hot-reload
  }
}

// ── Matching a query to the index that serves it ────────────────

export type QueryShape = { equals: string[]; ranges: string[]; order: string | null }

const RANGE_OPS = new Set(['<', '>', '<=', '>='])

export function queryShape(
  wheres: [string, string, unknown][],
  docFilters: AppliedFilter[] | undefined,
  orderBy: string | undefined,
  defaultOrder: string | null
): QueryShape {
  const equals: string[] = []
  const ranges: string[] = []
  const add = (list: string[], field: string) => { if (!list.includes(field)) list.push(field) }
  for (const f of docFilters ?? []) if (f.value !== null || f.values) add(equals, f.field)
  for (const [field, op, value] of wheres) {
    if (op === '==' || op === 'in' || (typeof value === 'boolean' && op !== '!=')) {
      if (field !== 'created' && field !== 'updated') add(equals, field)
    } else if (RANGE_OPS.has(op)) {
      add(ranges, field)
    }
  }
  return { equals, ranges, order: orderBy ?? defaultOrder }
}

function serves(index: DeclaredIndex, shape: QueryShape): number {
  const equals = index.equals ?? []
  if (!equals.every((field) => shape.equals.includes(field))) return 0
  const ordered = !!index.orderedBy && (index.orderedBy === shape.order || shape.ranges.includes(index.orderedBy))
  if (equals.length === 0 && !ordered) return 0
  return equals.length * 2 + (ordered ? 1 : 0)
}

/** The indexes.json entry that would index this shape. */
export function suggestIndex(shape: QueryShape): DeclaredIndex | null {
  const equals = shape.equals.slice(0, MAX_EQUALS)
  const orderedBy = shape.ranges[0] ?? shape.order ?? undefined
  if (equals.length === 0 && !orderedBy) return null
  return { ...(equals.length ? { equals } : {}), ...(orderedBy ? { orderedBy } : {}) }
}

/** The X-Ezbase-Index value: the declared entry that serves this shape, or the exact entry to add to indexes.json. */
export function describeIndexUse(collection: string, shape: QueryShape): string {
  let best: { index: DeclaredIndex; score: number } | null = null
  for (const index of declared.collections[collection]?.indexes ?? []) {
    const score = serves(index, shape)
    if (score > (best?.score ?? 0)) best = { index, score }
  }
  if (best && ((best.index.equals?.length ?? 0) > 0 || shape.equals.length === 0)) return `declared ${JSON.stringify(best.index)}`
  const suggestion = suggestIndex(shape)
  return suggestion ? `undeclared; add ${JSON.stringify(suggestion)}` : 'full scan'
}

const servedNow = (collection: string, index: DeclaredIndex) =>
  describeIndexUse(collection, { equals: index.equals ?? [], ranges: [], order: index.orderedBy ?? null }).startsWith('declared')

export type DeclaredIndexStatus = DeclaredIndex & {
  database: string
  collection: string
  name: string
  state: 'ready' | 'building' | 'queued' | 'no collection'
  sizeBytes: number
  reads: number
}

/** Every declared index in every database: its Postgres name, build state, size, and reads. */
export async function declaredIndexStatus(): Promise<DeclaredIndexStatus[]> {
  const out: DeclaredIndexStatus[] = []
  for (const database of await databases()) {
    for (const [collection, { indexes }] of Object.entries(declared.collections)) {
      const exists = await collectionExists(database, collection)
      for (const index of indexes) {
        const def = definitionOf(database, collection, index)
        if (!def) continue
        const [row] = exists
          ? await sql<{ valid: boolean; size: string; reads: string | null }[]>`
              SELECT i.indisvalid AS valid, pg_relation_size(c.oid) AS size, s.idx_scan AS reads
              FROM pg_class c
              JOIN pg_index i ON i.indexrelid = c.oid
              JOIN pg_namespace n ON n.oid = c.relnamespace
              LEFT JOIN pg_stat_user_indexes s ON s.indexrelid = c.oid
              WHERE n.nspname = ${`db_${database}`} AND c.relname = ${def.name}`
          : []
        out.push({
          database,
          collection,
          ...index,
          name: def.name,
          state: !exists ? 'no collection' : !row ? 'queued' : row.valid ? 'ready' : 'building',
          sizeBytes: Number(row?.size ?? 0),
          reads: Number(row?.reads ?? 0),
        })
      }
    }
  }
  return out
}

// ── Unserved queries ──────────────────────────────────────────────

type PendingUnserved = { db: string; collection: string; entry: string; queries: number; total_ms: number }
const pendingUnserved = new Map<string, PendingUnserved>()

/** Counts a query no declared index served, with its database time, under the entry that would serve it. */
export function recordUnserved(database: string, collection: string, index: DeclaredIndex | null, ms: number) {
  if (!index) return
  const entry = JSON.stringify(index)
  const key = `${database}/${collection}/${entry}`
  const row = pendingUnserved.get(key)
  if (row) {
    row.queries++
    row.total_ms += ms
  } else {
    pendingUnserved.set(key, { db: database, collection, entry, queries: 1, total_ms: ms })
  }
}

async function flushUnserved() {
  if (pendingUnserved.size === 0) return
  const rows = [...pendingUnserved.values()]
  pendingUnserved.clear()
  const now = Date.now()
  await sql`
    INSERT INTO _ezbase_unserved ${sql(rows.map((row) => ({ ...row, last_seen: now })))}
    ON CONFLICT (db, collection, entry) DO UPDATE SET
      queries = _ezbase_unserved.queries + EXCLUDED.queries,
      total_ms = _ezbase_unserved.total_ms + EXCLUDED.total_ms,
      last_seen = EXCLUDED.last_seen
  `
  await sql`DELETE FROM _ezbase_unserved WHERE last_seen < ${now - UNSERVED_RETENTION_MS}`
}

export type UnservedShape = { index: DeclaredIndex; queries: number; totalMs: number; lastSeen: number }

/** Recorded shapes no declared index serves yet, slowest in total first. */
async function unservedShapes(database?: string, collection?: string): Promise<(UnservedShape & { database: string; collection: string })[]> {
  const rows = await sql<{ db: string; collection: string; entry: string; queries: string; total_ms: number; last_seen: string }[]>`
    SELECT db, collection, entry, queries, total_ms, last_seen FROM _ezbase_unserved
    WHERE (${database ?? null}::text IS NULL OR db = ${database ?? null})
      AND (${collection ?? null}::text IS NULL OR collection = ${collection ?? null})
    ORDER BY total_ms DESC
  `
  return rows
    .map((row) => ({
      database: row.db,
      collection: row.collection,
      index: JSON.parse(row.entry) as DeclaredIndex,
      queries: Number(row.queries),
      totalMs: Math.round(row.total_ms),
      lastSeen: Number(row.last_seen),
    }))
    .filter((row) => !servedNow(row.collection, row.index))
}

// ── One collection's indexes, and a starting indexes.json ─────────

export type IndexKind = 'primary' | 'unique' | 'declared' | 'undeclared'

export type CollectionIndex = {
  name: string
  kind: IndexKind
  fields: string[]
  method: string
  sizeBytes: number
  reads: number
  valid: boolean
  /** For an undeclared index: the indexes.json entry that keeps it. */
  entry?: DeclaredIndex
}

/** The fields an index covers, read from its definition: `(data -> 'a'::text), created_at` → `a`, `created`. */
function indexFields(definition: string): string[] {
  const body = definition.split(/\sWHERE\s/)[0]!
  const columns = body.slice(body.indexOf('(') + 1, body.lastIndexOf(')'))
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const ch of columns) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      parts.push(current)
      current = ''
    } else current += ch
  }
  parts.push(current)
  return parts.map((part) => {
    const keys = [...part.matchAll(/'([^']+)'::text/g)].map((m) => m[1])
    if (keys.length) return keys.join('.')
    const word = part.replace(/[()\s]/g, '').replace(/jsonb_path_ops$/, '')
    return word === 'created_at' ? 'created' : word === 'updated_at' ? 'updated' : word
  })
}

/**
 * The indexes.json entry an existing index answers to: exact when ezbase built it, else equality
 * fields then the last as order. Null for an index no entry can express (GIN, other columns).
 */
function entryForIndex(database: string, collection: string, name: string, definition: string): DeclaredIndex | null {
  if (!/ USING btree /.test(definition)) return null
  const fields = indexFields(definition)
  const body = definition.split(/\sWHERE\s/)[0]!
  const columns = body.slice(body.indexOf('(') + 1, body.lastIndexOf(')'))
  const jsonParts = columns.split(',').filter((part) => /'::text/.test(part)).length
  const timestampParts = fields.filter((f) => f === 'created' || f === 'updated').length
  if (fields.length === 0 || jsonParts + timestampParts < fields.length) return null
  const last = fields[fields.length - 1]!
  const head = fields.slice(0, -1)
  const ordered: DeclaredIndex = head.length ? { equals: head, orderedBy: last } : { orderedBy: last }
  const candidates = fields.some((f) => f === 'created' || f === 'updated') ? [ordered] : [ordered, { equals: fields }]
  return candidates.find((c) => definitionOf(database, collection, c)?.name === name) ?? ordered
}

/** Every index on one collection with its kind, fields, size, and reads; plus declared entries, unserved shapes, and sizes. */
export async function collectionIndexes(database: string, collection: string) {
  const schema = `db_${database}`
  const table = `col_${collection}`
  const rows = await sql<{ name: string; def: string; size: string; reads: string; valid: boolean; primary: boolean; unique: boolean; method: string }[]>`
    SELECT c.relname AS name, pg_get_indexdef(c.oid) AS def, pg_relation_size(c.oid) AS size,
           coalesce(s.idx_scan, 0) AS reads, i.indisvalid AS valid, i.indisprimary AS primary,
           i.indisunique AS unique, am.amname AS method
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_am am ON am.oid = c.relam
    LEFT JOIN pg_stat_user_indexes s ON s.indexrelid = c.oid
    WHERE n.nspname = ${schema} AND t.relname = ${table}
    ORDER BY pg_relation_size(c.oid) DESC`
  const wanted = definitionsFor(database, collection)
  const indexes: CollectionIndex[] = rows.map((row) => {
    const kind: IndexKind = row.primary ? 'primary' : row.unique ? 'unique' : wanted.has(row.name) ? 'declared' : 'undeclared'
    const entry = kind === 'undeclared' ? entryForIndex(database, collection, row.name, row.def) : null
    return {
      name: row.name,
      kind,
      fields: indexFields(row.def),
      method: row.method,
      sizeBytes: Number(row.size),
      reads: Number(row.reads),
      valid: row.valid,
      ...(entry ? { entry } : {}),
    }
  })
  const [sizes] = await sql<{ table: string; indexes: string }[]>`
    SELECT pg_table_size(${`"${schema}"."${table}"`}::regclass) AS table, pg_indexes_size(${`"${schema}"."${table}"`}::regclass) AS indexes`
  const ready = new Set(indexes.filter((i) => i.valid).map((i) => i.name))
  const declaredHere = (declared.collections[collection]?.indexes ?? []).map((index) => {
    const def = definitionOf(database, collection, index)
    return { ...index, name: def?.name ?? null, built: def ? ready.has(def.name) : false }
  })
  const suggested = (await unservedShapes(database, collection)).map(({ index, queries, totalMs, lastSeen }) => ({ index, queries, totalMs, lastSeen }))
  return {
    tableBytes: Number(sizes.table),
    indexBytes: Number(sizes.indexes),
    indexes,
    declared: declaredHere,
    suggested,
    managed,
    writable: indexesWritable(),
  }
}

/**
 * A complete indexes.json to start from: what is declared, every existing index
 * that queries have read (as the entry that rebuilds or adopts it), and every
 * recorded unserved shape, most used first.
 */
export async function suggestedIndexes(): Promise<IndexesFile> {
  const byCollection = new Map<string, Map<string, { index: DeclaredIndex; weight: number }>>()
  const add = (collection: string, index: DeclaredIndex, weight: number) => {
    if (validateIndexes({ collections: { [collection]: { indexes: [index] } } })) return
    const def = definitionOf('default', collection, index)
    if (!def) return
    const key = `${def.columns} ${def.partial ?? ''}`
    const entries = byCollection.get(collection) ?? new Map()
    const prev = entries.get(key)
    entries.set(key, { index: prev?.weight === Infinity ? prev.index : index, weight: Math.max(prev?.weight ?? 0, weight) })
    byCollection.set(collection, entries)
  }

  for (const [collection, { indexes }] of Object.entries(declared.collections)) {
    for (const index of indexes) add(collection, index, Infinity)
  }
  const read = await sql<{ schema: string; table: string; name: string; def: string; reads: string }[]>`
    SELECT n.nspname AS schema, t.relname AS table, c.relname AS name, pg_get_indexdef(c.oid) AS def, s.idx_scan AS reads
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_stat_user_indexes s ON s.indexrelid = c.oid
    WHERE n.nspname LIKE 'db\\_%' ESCAPE '\\' AND t.relname LIKE 'col\\_%' ESCAPE '\\'
      AND NOT i.indisprimary AND NOT i.indisunique AND i.indisvalid AND s.idx_scan > 0`
  for (const row of read) {
    const database = row.schema.slice(3)
    const collection = row.table.slice(4)
    const entry = validateCollectionName(collection) ? null : entryForIndex(database, collection, row.name, row.def)
    if (entry) add(collection, entry, Number(row.reads))
  }
  for (const shape of await unservedShapes()) add(shape.collection, shape.index, shape.queries)

  const collections: IndexesFile['collections'] = {}
  for (const collection of [...byCollection.keys()].sort()) {
    const indexes = [...byCollection.get(collection)!.values()]
      .sort((a, b) => b.weight - a.weight)
      .slice(0, MAX_PER_COLLECTION)
      .map(({ index }) => index)
    collections[collection] = { indexes }
  }
  return { collections }
}

function indexesWritable(): boolean {
  try {
    fs.accessSync(fs.existsSync(INDEXES_PATH) ? INDEXES_PATH : INDEXES_PATH.slice(0, INDEXES_PATH.lastIndexOf('/')) || '.', fs.constants.W_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Replaces one collection's declared indexes in indexes.json; the watcher builds and drops to match.
 * Without a file yet, it starts from suggestedIndexes() so declaring one collection keeps every
 * other collection's indexes in use.
 */
export async function writeCollectionIndexes(collection: string, indexes: DeclaredIndex[]): Promise<IndexesFile> {
  if (!indexesWritable()) throw new Error('indexes.json is read-only (mounted volume)')
  const base = managed ? declared : await suggestedIndexes()
  const next: IndexesFile = { collections: { ...base.collections } }
  if (indexes.length) next.collections[collection] = { indexes }
  else delete next.collections[collection]
  const err = validateIndexes(next)
  if (err) throw new Error(err)
  fs.writeFileSync(INDEXES_PATH, JSON.stringify(next, null, 2) + '\n')
  setDeclared({ file: next, present: true })
  apply()
  return next
}
