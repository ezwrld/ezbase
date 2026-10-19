import type { AppliedFilter } from './rules.js'
import { autoIndexEnabled, ensureQueryIndexes, jsonPath, qualifiedTableName } from './db.js'

export { autoIndexEnabled }

const OPS: Record<string, string> = {
  '==': '=',
  '!=': '!=',
  '<': '<',
  '>': '>',
  '<=': '<=',
  '>=': '>=',
  in: 'in',
}

const KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/
const MAX_PATH_DEPTH = 8
const MAX_IN_VALUES = 10000

/** A document field, optionally a dotted path into nested objects (`stats.rushingYards`). */
export function sanitizeField(field: string): string {
  const parts = typeof field === 'string' ? field.split('.') : []
  if (parts.length === 0 || parts.length > MAX_PATH_DEPTH || !parts.every((part) => KEY_RE.test(part))) {
    throw new Error(`Invalid field name: ${field}`)
  }
  return field
}

function sanitizeKey(field: string): string {
  if (!KEY_RE.test(field)) throw new Error(`Invalid field name: ${field}`)
  return field
}

export function parseFields(value?: string): string[] | undefined {
  if (value === undefined) return undefined

  const fields = value.split(',').map((field) => field.trim())
  if (fields.length === 0 || fields.length > 64 || fields.some((field) => !field)) {
    throw new Error('fields must contain 1 to 64 comma-separated field names')
  }

  return Array.from(new Set(fields.map(sanitizeKey)))
}

/** Never let an untrusted query choose which persistent indexes get created. */
export function shouldEnsureQueryIndexes(isAdmin: boolean): boolean {
  return isAdmin && autoIndexEnabled()
}

function timestampColumn(field: string): 'created_at' | 'updated_at' | null {
  if (field === 'created') return 'created_at'
  if (field === 'updated') return 'updated_at'
  return null
}

/** `data->'a'->>'b'` — the text form used when predicates target the GIN index. */
function jsonTextPath(field: string): string {
  const parts = field.split('.')
  const last = parts.pop()
  return `data${parts.map((part) => `->'${part}'`).join('')}->>'${last}'`
}

function nested(field: string, value: unknown): Record<string, unknown> {
  return field.split('.').reduceRight<unknown>((acc, key) => ({ [key]: acc }), value) as Record<string, unknown>
}

export type Subquery = { collection: string; where?: WhereClause[]; field?: string }
export type WhereClause = [string, string, unknown]

/** Read access to a collection used in a subquery, resolved by the route. */
export type SubqueryAccess = Map<string, { exists: boolean; filters?: AppliedFilter[] }>

export function parseWhere(whereParam?: string | unknown): WhereClause[] {
  if (whereParam === undefined || whereParam === '') return []
  const parsed = typeof whereParam === 'string' ? JSON.parse(whereParam) : whereParam
  if (!Array.isArray(parsed)) throw new Error('where must be an array')
  for (const clause of parsed) {
    if (!Array.isArray(clause) || clause.length !== 3 || typeof clause[0] !== 'string') {
      throw new Error('each where clause must be [field, op, value]')
    }
    if (!(clause[1] in OPS)) throw new Error(`Unsupported where operator: ${clause[1]}`)
  }
  return parsed as WhereClause[]
}

function isSubquery(value: unknown): value is Subquery {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseSubquery(value: Subquery): Required<Subquery> {
  if (typeof value.collection !== 'string' || !value.collection) {
    throw new Error('in subquery requires a collection')
  }
  const where = parseWhere(value.where ?? [])
  if (where.some(([, op, v]) => op === 'in' && isSubquery(v))) {
    throw new Error('in subqueries cannot be nested')
  }
  const field = value.field ?? 'id'
  if (field !== 'id') sanitizeField(field)
  return { collection: value.collection, where, field }
}

/** Collections referenced by `in` subqueries, so the route can check read access. */
export function subqueryCollections(wheres: WhereClause[]): string[] {
  const names = new Set<string>()
  for (const [, op, value] of wheres) {
    if (op === 'in' && isSubquery(value)) names.add(parseSubquery(value).collection)
  }
  return [...names]
}

export function collectIndexHints(
  wheres: WhereClause[],
  orderBy?: string,
  docFilters?: AppliedFilter[],
  ordered = true
) {
  const eqFields: string[] = []
  const jsonFields: string[] = []

  const addJson = (field: string) => {
    if (!jsonFields.includes(field)) jsonFields.push(field)
  }
  const addEq = (field: string) => {
    addJson(field)
    if (!eqFields.includes(field)) eqFields.push(field)
  }

  for (const [field, op] of wheres) {
    if (timestampColumn(field)) continue
    const name = sanitizeField(field)
    if (op === '==') addEq(name)
    else addJson(name)
  }

  if (docFilters) {
    for (const f of docFilters) {
      addEq(sanitizeField(f.field))
    }
  }

  let orderField: string | null = null
  if (!ordered) {
    orderField = null
  } else if (orderBy) {
    orderField = timestampColumn(orderBy) ?? sanitizeField(orderBy)
    if (!timestampColumn(orderBy)) addJson(orderField)
  } else {
    orderField = 'created_at'
  }

  return { eqFields, jsonFields, orderField }
}

function jsonbParam(params: unknown[], value: unknown): string {
  params.push(value)
  let cast = 'text'
  if (typeof value === 'number') cast = 'numeric'
  else if (typeof value === 'boolean') cast = 'boolean'
  return `to_jsonb($${params.length}::${cast})`
}

function equality(params: unknown[], field: string, value: unknown, negate: boolean, useJsonb: boolean): string {
  if (useJsonb) {
    return `${jsonPath(field)} ${negate ? 'IS DISTINCT FROM' : '='} ${jsonbParam(params, value)}`
  }
  params.push(JSON.stringify(nested(field, value)))
  const pred = `data @> ($${params.length}::text)::jsonb`
  return negate ? `NOT ${pred}` : pred
}

function inValues(params: unknown[], field: string, values: unknown[], useJsonb: boolean): string {
  if (values.length > MAX_IN_VALUES) throw new Error(`in accepts at most ${MAX_IN_VALUES} values`)
  if (values.length === 0) return 'false'
  for (const value of values) {
    if (value === null || typeof value === 'object') throw new Error('in values must be strings, numbers or booleans')
  }
  if (useJsonb) {
    return `${jsonPath(field)} IN (${values.map((value) => jsonbParam(params, value)).join(', ')})`
  }
  params.push(values.map(String))
  return `${jsonTextPath(field)} = ANY($${params.length})`
}

function inSubquery(
  params: unknown[],
  field: string,
  value: Subquery,
  ctx: WhereContext
): string {
  const sub = parseSubquery(value)
  const access = ctx.subqueries?.get(sub.collection)
  if (!access) throw new Error(`No read access resolved for ${sub.collection}`)
  if (!access.exists) return 'false'

  const inner = wherePredicates(sub.where, access.filters, params, { ...ctx, subqueries: undefined })
  const table = qualifiedTableName(ctx.database, sub.collection)
  const filter = inner.length ? ` WHERE ${inner.join(' AND ')}` : ''
  if (ctx.useJsonb) {
    const selected = sub.field === 'id' ? 'to_jsonb(id)' : jsonPath(sub.field)
    return `${jsonPath(field)} = ANY(ARRAY(SELECT ${selected} FROM ${table}${filter}))`
  }
  const selected = sub.field === 'id' ? 'id' : jsonTextPath(sub.field)
  return `${jsonTextPath(field)} = ANY(ARRAY(SELECT ${selected} FROM ${table}${filter}))`
}

type WhereContext = {
  database: string
  useJsonb: boolean
  subqueries?: SubqueryAccess
}

function docFilterPredicates(params: unknown[], docFilters: AppliedFilter[] | undefined, useJsonb: boolean): string[] {
  const predicates: string[] = []
  for (const f of docFilters ?? []) {
    const field = sanitizeField(f.field)
    if (f.values) {
      if (useJsonb) {
        predicates.push(`${jsonPath(field)} IN (${f.values.map((value) => jsonbParam(params, value)).join(', ')})`)
      } else {
        params.push(f.values)
        predicates.push(`${jsonTextPath(field)} = ANY($${params.length})`)
      }
    } else if (f.value !== null) {
      predicates.push(equality(params, field, f.value, false, useJsonb))
    }
  }
  return predicates
}

function wherePredicates(
  wheres: WhereClause[],
  docFilters: AppliedFilter[] | undefined,
  params: unknown[],
  ctx: WhereContext
): string[] {
  const predicates = docFilterPredicates(params, docFilters, ctx.useJsonb)

  for (const [field, op, value] of wheres) {
    const colName = timestampColumn(field)
    if (colName) {
      if (op === 'in') throw new Error(`in is not supported on ${field}`)
      params.push(value)
      predicates.push(`${colName} ${OPS[op]} $${params.length}`)
      continue
    }

    const path = sanitizeField(field)

    if (op === 'in') {
      if (Array.isArray(value)) predicates.push(inValues(params, path, value, ctx.useJsonb))
      else if (isSubquery(value)) predicates.push(inSubquery(params, path, value, ctx))
      else throw new Error('in requires an array or a subquery')
      continue
    }

    if (op === '==' || op === '!=' || typeof value === 'boolean') {
      predicates.push(equality(params, path, value, op === '!=', ctx.useJsonb))
      continue
    }

    const sqlOp = OPS[op]
    params.push(value)
    const idx = params.length
    if (typeof value === 'number') {
      predicates.push(ctx.useJsonb
        ? `${jsonPath(path)} ${sqlOp} to_jsonb($${idx}::numeric)`
        : `(${jsonTextPath(path)})::numeric ${sqlOp} $${idx}`)
    } else {
      predicates.push(ctx.useJsonb
        ? `${jsonPath(path)} ${sqlOp} to_jsonb($${idx}::text)`
        : `${jsonTextPath(path)} ${sqlOp} $${idx}`)
    }
  }

  return predicates
}

function selectClause(fields?: string[]): string {
  if (!fields) return '*'

  const names = fields.map((field) => `'${field}'`).join(', ')
  return `id, COALESCE((
    SELECT jsonb_object_agg(entry.key, entry.value)
    FROM jsonb_each(data) AS entry
    WHERE entry.key IN (${names})
  ), '{}'::jsonb) AS data, created_at, updated_at`
}

function resolveLimit(limit: string | number | undefined): number {
  const DEFAULT_LIMIT = parseInt(process.env.EZBASE_DEFAULT_LIMIT || '100', 10)
  const MAX_LIMIT = parseInt(process.env.EZBASE_MAX_LIMIT || '10000', 10)
  if (limit !== undefined && limit !== '') {
    const n = typeof limit === 'number' ? limit : parseInt(limit, 10)
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error('limit must be a positive integer')
    }
    return Math.min(n, MAX_LIMIT)
  }
  return DEFAULT_LIMIT
}

function appendOffset(params: unknown[], offset: string | number | undefined): string {
  const n = typeof offset === 'number' ? offset : parseInt(offset || '0', 10)
  if (!(n > 0)) return ''
  params.push(n)
  return ` OFFSET $${params.length}`
}

export function buildQuerySql(
  database: string,
  collection: string,
  whereParam?: string,
  orderBy?: string,
  order?: string,
  limitParam?: string,
  docFilters?: AppliedFilter[],
  offsetParam?: string,
  fields?: string[],
  isAdmin = false,
  useJsonbPredicates = autoIndexEnabled(),
  subqueries?: SubqueryAccess
): { query: string; params: unknown[] } {
  void isAdmin
  const params: unknown[] = []
  const predicates = wherePredicates(parseWhere(whereParam), docFilters, params, {
    database,
    useJsonb: useJsonbPredicates,
    subqueries,
  })

  let query = `SELECT ${selectClause(fields)} FROM ${qualifiedTableName(database, collection)} WHERE ${predicates.length ? predicates.join(' AND ') : 'true'}`

  if (orderBy) {
    const dir = (order || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC'
    const colName = timestampColumn(orderBy)
    query += colName ? ` ORDER BY ${colName} ${dir}` : ` ORDER BY ${jsonPath(sanitizeField(orderBy))} ${dir}`
  } else {
    query += ' ORDER BY created_at DESC'
  }

  params.push(resolveLimit(limitParam))
  query += ` LIMIT $${params.length}`
  query += appendOffset(params, offsetParam)

  return { query, params }
}

async function ensureWhereIndexes(
  database: string,
  wheres: WhereClause[],
  collection: string,
  orderBy: string | undefined,
  docFilters: AppliedFilter[] | undefined,
  subqueries: SubqueryAccess | undefined,
  ordered: boolean
) {
  await ensureQueryIndexes(database, collection, collectIndexHints(wheres, orderBy, docFilters, ordered))
  for (const [, op, value] of wheres) {
    if (op !== 'in' || !isSubquery(value)) continue
    const sub = parseSubquery(value)
    const access = subqueries?.get(sub.collection)
    if (!access?.exists) continue
    await ensureQueryIndexes(database, sub.collection, collectIndexHints(sub.where, undefined, access.filters, false))
  }
}

export async function prepareQuery(
  database: string,
  collection: string,
  whereParam?: string,
  orderBy?: string,
  order?: string,
  limitParam?: string,
  docFilters?: AppliedFilter[],
  offsetParam?: string,
  fields?: string[],
  isAdmin = false,
  subqueries?: SubqueryAccess
): Promise<{ query: string; params: unknown[] }> {
  const useJsonb = autoIndexEnabled()
  if (shouldEnsureQueryIndexes(isAdmin)) {
    await ensureWhereIndexes(database, parseWhere(whereParam), collection, orderBy, docFilters, subqueries, true)
  }
  return buildQuerySql(
    database,
    collection,
    whereParam,
    orderBy,
    order,
    limitParam,
    docFilters,
    offsetParam,
    fields,
    isAdmin,
    useJsonb,
    subqueries
  )
}

// ── Aggregation ──────────────────────────────────────────────

const AGGREGATE_FNS = ['count', 'countDistinct', 'sum', 'avg', 'min', 'max'] as const
type AggregateFn = typeof AGGREGATE_FNS[number]
const MAX_GROUP_BY = 8
const MAX_OUTPUTS = 32

export type AggregateRequest = {
  where?: WhereClause[]
  groupBy?: string[]
  select: Record<string, [AggregateFn, string?]>
  having?: WhereClause[]
  orderBy?: string
  order?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

/** A JSON number as numeric; anything else (strings, null, missing) is ignored by the aggregate. */
function numeric(field: string): string {
  const path = jsonPath(field)
  return `CASE WHEN jsonb_typeof(${path}) = 'number' THEN (${path})::numeric END`
}

function aggregateExpr([fn, field]: [AggregateFn, string?]): string {
  if (!AGGREGATE_FNS.includes(fn)) throw new Error(`Unsupported aggregate: ${fn}`)
  if (fn === 'count') {
    if (field === undefined) return 'count(*)::int'
    return `count(${jsonPath(sanitizeField(field))})::int`
  }
  if (typeof field !== 'string') throw new Error(`${fn} requires a field`)
  const path = sanitizeField(field)
  if (fn === 'countDistinct') return `count(DISTINCT ${jsonPath(path)})::int`
  return `${fn}(${numeric(path)})::float8`
}

export function parseAggregate(body: unknown): AggregateRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error('aggregate body must be an object')
  }
  const req = body as AggregateRequest
  const groupBy = req.groupBy ?? []
  if (!Array.isArray(groupBy) || groupBy.length > MAX_GROUP_BY) {
    throw new Error(`groupBy must be an array of at most ${MAX_GROUP_BY} fields`)
  }
  groupBy.forEach(sanitizeField)
  if (typeof req.select !== 'object' || req.select === null || Array.isArray(req.select)) {
    throw new Error('select must map output names to [fn, field]')
  }
  const names = Object.keys(req.select)
  if (names.length === 0 || names.length > MAX_OUTPUTS) {
    throw new Error(`select must have 1 to ${MAX_OUTPUTS} outputs`)
  }
  for (const name of names) {
    sanitizeKey(name)
    if (groupBy.includes(name)) throw new Error(`select output ${name} collides with a groupBy field`)
    if (!Array.isArray(req.select[name])) throw new Error(`select.${name} must be [fn, field]`)
  }
  return { ...req, where: parseWhere(req.where ?? []), groupBy, having: req.having ?? [] }
}

export function buildAggregateSql(
  database: string,
  collection: string,
  req: AggregateRequest,
  docFilters?: AppliedFilter[],
  useJsonbPredicates = autoIndexEnabled(),
  subqueries?: SubqueryAccess
): { query: string; params: unknown[] } {
  const params: unknown[] = []
  const groupBy = req.groupBy ?? []
  const outputs = Object.entries(req.select).map(([name, spec]) => ({ name, expr: aggregateExpr(spec) }))

  const columns = [
    ...groupBy.map((field, i) => `${jsonPath(field)} AS "group:${i}"`),
    ...outputs.map(({ name, expr }) => `${expr} AS "${name}"`),
  ]

  const predicates = wherePredicates(req.where ?? [], docFilters, params, {
    database,
    useJsonb: useJsonbPredicates,
    subqueries,
  })
  let query = `SELECT ${columns.join(', ')} FROM ${qualifiedTableName(database, collection)} WHERE ${predicates.length ? predicates.join(' AND ') : 'true'}`
  if (groupBy.length) query += ` GROUP BY ${groupBy.map((_, i) => i + 1).join(', ')}`

  const having = parseWhere(req.having ?? []).map(([name, op, value]) => {
    const output = outputs.find((o) => o.name === name)
    if (!output) throw new Error(`having must reference a select output: ${name}`)
    if (op === 'in' || typeof value !== 'number') throw new Error('having compares an output to a number')
    params.push(value)
    return `${output.expr} ${OPS[op]} $${params.length}`
  })
  if (having.length) query += ` HAVING ${having.join(' AND ')}`

  if (req.orderBy) {
    const dir = req.order === 'desc' ? 'DESC' : 'ASC'
    const groupIndex = groupBy.indexOf(req.orderBy)
    let target: string
    if (groupIndex >= 0) target = `"group:${groupIndex}"`
    else if (outputs.some((o) => o.name === req.orderBy)) target = `"${req.orderBy}"`
    else throw new Error(`orderBy must be a groupBy field or select output: ${req.orderBy}`)
    query += ` ORDER BY ${target} ${dir} NULLS LAST`
  }

  params.push(resolveLimit(req.limit))
  query += ` LIMIT $${params.length}`
  query += appendOffset(params, req.offset)

  return { query, params }
}

export async function prepareAggregate(
  database: string,
  collection: string,
  req: AggregateRequest,
  docFilters?: AppliedFilter[],
  isAdmin = false,
  subqueries?: SubqueryAccess
): Promise<{ query: string; params: unknown[] }> {
  if (shouldEnsureQueryIndexes(isAdmin)) {
    await ensureWhereIndexes(database, req.where ?? [], collection, undefined, docFilters, subqueries, false)
  }
  return buildAggregateSql(database, collection, req, docFilters, autoIndexEnabled(), subqueries)
}

/** Rename `group:N` columns back to their groupBy field names. */
export function formatAggregateRow(row: Record<string, unknown>, groupBy: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  groupBy.forEach((field, i) => {
    out[field] = row[`group:${i}`] ?? null
  })
  for (const [key, value] of Object.entries(row)) {
    if (!key.startsWith('group:')) out[key] = value
  }
  return out
}
