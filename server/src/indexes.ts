import * as fs from 'node:fs'
import {
  collectionExists,
  indexDefinition,
  onCollectionCreated,
  sanitizeField,
  sql,
  validateCollectionName,
  type IndexDefinition,
} from './db.js'
import type { AppliedFilter } from './rules.js'

/**
 * Declared indexes: /data/indexes.json lists, per collection, the query shapes
 * worth an index. ezbase builds each one concurrently, adopts an identical index
 * the auto-indexer already built, and drops a declared index that leaves the file.
 *
 *   { "collections": { "player_game_stats": { "indexes": [
 *       { "equals": ["gameId"], "orderedBy": "updated" } ] } } }
 */

export type DeclaredIndex = { equals?: string[]; orderedBy?: string }
export type IndexesFile = { collections: Record<string, { indexes: DeclaredIndex[] }> }

const INDEXES_PATH = process.env.INDEXES_PATH || '/data/indexes.json'
const DECLARED = 'ezbase declared'
const MAX_EQUALS = 3
const MAX_PER_COLLECTION = 32

let declared: IndexesFile = { collections: {} }
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

function read(): IndexesFile | null {
  if (!fs.existsSync(INDEXES_PATH)) return { collections: {} }
  const parsed = JSON.parse(fs.readFileSync(INDEXES_PATH, 'utf-8'))
  const err = validateIndexes(parsed)
  if (err) {
    console.warn(`ezbase: indexes.json ignored: ${err}`)
    return null
  }
  return { collections: parsed.collections ?? {} }
}

const orderColumn = (orderedBy?: string): string | null =>
  orderedBy === 'created' ? 'created_at' : orderedBy === 'updated' ? 'updated_at' : orderedBy ?? null

function definitionsFor(database: string, collection: string): Map<string, IndexDefinition> {
  const wanted = new Map<string, IndexDefinition>()
  for (const index of declared.collections[collection]?.indexes ?? []) {
    const def = indexDefinition(database, collection, index.equals ?? [], orderColumn(index.orderedBy))
    if (def) wanted.set(def.name, def)
  }
  return wanted
}

async function applyTo(database: string, collection: string) {
  if (!(await collectionExists(database, collection))) return
  const schema = `db_${database}`
  const tableName = `col_${collection}`
  const table = `${schema}.${tableName}`
  const wanted = definitionsFor(database, collection)
  const existing = await sql<{ name: string; valid: boolean; note: string | null }[]>`
    SELECT c.relname AS name, i.indisvalid AS valid, obj_description(c.oid, 'pg_class') AS note
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = ${schema} AND t.relname = ${tableName}
  `
  const byName = new Map(existing.map((row) => [row.name, row]))

  for (const def of wanted.values()) {
    const row = byName.get(def.name)
    try {
      if (row && !row.valid) await sql.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS ${schema}.${def.name}`)
      if (!row || !row.valid) {
        const t0 = Date.now()
        await sql.unsafe(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${def.name} ON ${table} (${def.columns})${def.partial ? ` WHERE ${def.partial}` : ''}`)
        await sql.unsafe(`ANALYZE ${table}`)
        console.log(`ezbase: built declared index ${def.name} in ${Date.now() - t0}ms`)
      }
      if (row?.note !== DECLARED) await sql.unsafe(`COMMENT ON INDEX ${schema}.${def.name} IS '${DECLARED}'`)
    } catch (error) {
      console.error(`ezbase: declared index ${def.name} failed:`, error)
      await sql.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS ${schema}.${def.name}`).catch(() => {})
    }
  }

  for (const row of existing) {
    if (row.note !== DECLARED || wanted.has(row.name)) continue
    await sql.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS ${schema}.${row.name}`)
    console.log(`ezbase: dropped ${row.name}, no longer declared`)
  }
}

async function databases(): Promise<string[]> {
  const rows = await sql<{ name: string }[]>`SELECT nspname AS name FROM pg_namespace WHERE nspname LIKE 'db\\_%' ESCAPE '\\'`
  return rows.map((row) => row.name.slice(3))
}

/** Builds and drops declared indexes, one at a time, in the background. */
function apply(target?: { database: string; collection: string }) {
  chain = chain.then(async () => {
    if (target) return applyTo(target.database, target.collection)
    const names = new Set(Object.keys(declared.collections))
    const marked = await sql<{ schema: string; table: string }[]>`
      SELECT DISTINCT n.nspname AS schema, t.relname AS table
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_class t ON t.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname LIKE 'db\\_%' ESCAPE '\\' AND obj_description(c.oid, 'pg_class') = ${DECLARED}
    `
    for (const row of marked) names.add(row.table.slice(4))
    for (const database of await databases()) {
      for (const collection of names) await applyTo(database, collection)
    }
  }).catch((error) => console.error('ezbase: applying indexes.json failed:', error))
  return chain
}

export async function loadIndexes() {
  const next = read()
  if (next) declared = next
  console.log(`ezbase: loaded indexes.json (${Object.values(declared.collections).reduce((n, c) => n + c.indexes.length, 0)} declared)`)
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
          declared = next
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

const BUILT_IN: DeclaredIndex[] = [{ orderedBy: 'created' }, { orderedBy: 'updated' }]

function serves(index: DeclaredIndex, shape: QueryShape): number {
  const equals = index.equals ?? []
  if (!equals.every((field) => shape.equals.includes(field))) return 0
  const ordered = !!index.orderedBy && (index.orderedBy === shape.order || shape.ranges.includes(index.orderedBy))
  if (index.orderedBy && !ordered && equals.length === 0) return 0
  if (equals.length === 0 && !ordered) return 0
  return equals.length * 2 + (ordered ? 1 : 0)
}

/** The declared entry that would index this shape. */
export function suggestIndex(shape: QueryShape): DeclaredIndex | null {
  const equals = shape.equals.slice(0, MAX_EQUALS)
  const orderedBy = shape.ranges[0] ?? shape.order ?? undefined
  if (equals.length === 0 && (!orderedBy || orderedBy === 'created' || orderedBy === 'updated')) return null
  return { ...(equals.length ? { equals } : {}), ...(orderedBy ? { orderedBy } : {}) }
}

/**
 * The X-Ezbase-Index value: which declared (or built-in created/updated) index
 * serves this shape, or the exact entry to add to indexes.json.
 */
export function describeIndexUse(collection: string, shape: QueryShape): string {
  let best: { index: DeclaredIndex; score: number; builtIn: boolean } | null = null
  for (const index of declared.collections[collection]?.indexes ?? []) {
    const score = serves(index, shape)
    if (score > (best?.score ?? 0)) best = { index, score, builtIn: false }
  }
  for (const index of BUILT_IN) {
    const score = serves(index, shape)
    if (score > (best?.score ?? 0)) best = { index, score, builtIn: true }
  }
  const narrows = !!best && ((best.index.equals?.length ?? 0) > 0 || shape.equals.length === 0)
  if (best && narrows) return best.builtIn ? `built-in ${best.index.orderedBy}` : `declared ${JSON.stringify(best.index)}`
  const suggestion = suggestIndex(shape)
  return suggestion ? `undeclared; add ${JSON.stringify(suggestion)}` : 'full scan'
}

export function isServedByDeclared(collection: string, shape: QueryShape): boolean {
  return describeIndexUse(collection, shape).startsWith('declared')
}

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
        const def = indexDefinition(database, collection, index.equals ?? [], orderColumn(index.orderedBy))
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
