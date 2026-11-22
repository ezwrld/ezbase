import type { AppliedFilter } from './rules.js'
import { describeIndexUse, queryShape, suggestIndex, type DeclaredIndex } from './indexes.js'
import { jsonPath, qualifiedTableName, sanitizeField } from './db.js'

export { sanitizeField }

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
const MAX_IN_VALUES = 10000


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

function timestampColumn(field: string): 'created_at' | 'updated_at' | null {
  if (field === 'created') return 'created_at'
  if (field === 'updated') return 'updated_at'
  return null
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

function jsonbParam(params: unknown[], value: unknown): string {
  params.push(value)
  let cast = 'text'
  if (typeof value === 'number') cast = 'numeric'
  else if (typeof value === 'boolean') cast = 'boolean'
  return `to_jsonb($${params.length}::${cast})`
}

function equality(params: unknown[], field: string, value: unknown, negate: boolean): string {
  return `${jsonPath(field)} ${negate ? 'IS DISTINCT FROM' : '='} ${jsonbParam(params, value)}`
}

function inValues(params: unknown[], field: string, values: unknown[]): string {
  if (values.length > MAX_IN_VALUES) throw new Error(`in accepts at most ${MAX_IN_VALUES} values`)
  if (values.length === 0) return 'false'
  for (const value of values) {
    if (value === null || typeof value === 'object') throw new Error('in values must be strings, numbers or booleans')
  }
  return `${jsonPath(field)} IN (${values.map((value) => jsonbParam(params, value)).join(', ')})`
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
  const selected = sub.field === 'id' ? 'to_jsonb(id)' : jsonPath(sub.field)
  return `${jsonPath(field)} = ANY(ARRAY(SELECT ${selected} FROM ${table}${filter}))`
}

type WhereContext = {
  database: string
  subqueries?: SubqueryAccess
}

function docFilterPredicates(params: unknown[], docFilters: AppliedFilter[] | undefined): string[] {
  const predicates: string[] = []
  for (const f of docFilters ?? []) {
    const field = sanitizeField(f.field)
    if (f.values) {
      predicates.push(`${jsonPath(field)} IN (${f.values.map((value) => jsonbParam(params, value)).join(', ')})`)
    } else if (f.value !== null) {
      predicates.push(equality(params, field, f.value, false))
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
  const predicates = docFilterPredicates(params, docFilters)

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
      if (Array.isArray(value)) predicates.push(inValues(params, path, value))
      else if (isSubquery(value)) predicates.push(inSubquery(params, path, value, ctx))
      else throw new Error('in requires an array or a subquery')
      continue
    }

    if (op === '==' || op === '!=' || typeof value === 'boolean') {
      predicates.push(equality(params, path, value, op === '!='))
      continue
    }

    const sqlOp = OPS[op]
    params.push(value)
    const idx = params.length
    predicates.push(`${jsonPath(path)} ${sqlOp} to_jsonb($${idx}::${typeof value === 'number' ? 'numeric' : 'text'})`)
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

const MAX_LIMIT = parseInt(process.env.EZBASE_MAX_LIMIT || '10000', 10)

/**
 * How many rows a request may return. Admin reads (`uncapped`) get exactly what they
 * ask for: no limit means every match, streamed. Everyone else gets at most
 * EZBASE_MAX_LIMIT; without a limit the query fetches one extra row so a cut is
 * refused instead of silently returning part of the result.
 */
type RowCap = { rows: number | null; strict: boolean }

function resolveLimit(limit: string | number | undefined, uncapped: boolean): RowCap {
  if (limit !== undefined && limit !== '') {
    const n = typeof limit === 'number' ? limit : parseInt(limit, 10)
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error('limit must be a positive integer')
    }
    if (n > MAX_LIMIT && !uncapped) throw new Error(`limit must be at most ${MAX_LIMIT}`)
    return { rows: n, strict: false }
  }
  return uncapped ? { rows: null, strict: false } : { rows: MAX_LIMIT, strict: true }
}

function pushLimit(params: unknown[], cap: RowCap): string {
  if (cap.rows === null) return ''
  params.push(cap.strict ? cap.rows + 1 : cap.rows)
  return ` LIMIT $${params.length}`
}

/** The 400 message when more rows match than a client may read at once, or null when the result is complete. */
export function truncationError(rowCount: number, cap: number | null): string | null {
  if (cap === null || rowCount <= cap) return null
  return `More than ${cap} documents match. Pass limit (at most ${MAX_LIMIT}) and page with offset, or narrow the where clause.`
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
  subqueries?: SubqueryAccess,
  uncapped = false
): { query: string; params: unknown[]; cap: number | null; stream: boolean } {
  const params: unknown[] = []
  const predicates = wherePredicates(parseWhere(whereParam), docFilters, params, { database, subqueries })

  let query = `SELECT ${selectClause(fields)} FROM ${qualifiedTableName(database, collection)} WHERE ${predicates.length ? predicates.join(' AND ') : 'true'}`

  if (orderBy) {
    const dir = (order || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC'
    const colName = timestampColumn(orderBy)
    query += colName ? ` ORDER BY ${colName} ${dir}` : ` ORDER BY ${jsonPath(sanitizeField(orderBy))} ${dir}`
  } else {
    query += ' ORDER BY created_at DESC'
  }

  const cap = resolveLimit(limitParam, uncapped)
  query += pushLimit(params, cap)
  query += appendOffset(params, offsetParam)

  return { query, params, cap: cap.strict ? cap.rows : null, stream: cap.rows === null || cap.rows > MAX_LIMIT }
}

/** Which declared index serves a query, and the indexes.json entry that would serve it when none does. */
export type IndexUse = { index: string; unserved: DeclaredIndex | null }

function indexUse(collection: string, ...shapeArgs: Parameters<typeof queryShape>): IndexUse {
  const shape = queryShape(...shapeArgs)
  const index = describeIndexUse(collection, shape)
  return { index, unserved: index.startsWith('undeclared') ? suggestIndex(shape) : null }
}

export function prepareQuery(
  database: string,
  collection: string,
  whereParam?: string,
  orderBy?: string,
  order?: string,
  limitParam?: string,
  docFilters?: AppliedFilter[],
  offsetParam?: string,
  fields?: string[],
  subqueries?: SubqueryAccess,
  uncapped = false
): IndexUse & { query: string; params: unknown[]; cap: number | null; stream: boolean } {
  return {
    ...indexUse(collection, parseWhere(whereParam), docFilters, orderBy, 'created'),
    ...buildQuerySql(database, collection, whereParam, orderBy, order, limitParam, docFilters, offsetParam, fields, subqueries, uncapped),
  }
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
  subqueries?: SubqueryAccess,
  uncapped = false
): { query: string; params: unknown[]; cap: number | null } {
  const params: unknown[] = []
  const groupBy = req.groupBy ?? []
  const outputs = Object.entries(req.select).map(([name, spec]) => ({ name, expr: aggregateExpr(spec) }))

  const columns = [
    ...groupBy.map((field, i) => `${jsonPath(field)} AS "group:${i}"`),
    ...outputs.map(({ name, expr }) => `${expr} AS "${name}"`),
  ]

  const predicates = wherePredicates(req.where ?? [], docFilters, params, { database, subqueries })
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

  const cap = resolveLimit(req.limit, uncapped)
  query += pushLimit(params, cap)
  query += appendOffset(params, req.offset)

  return { query, params, cap: cap.strict ? cap.rows : null }
}

export function prepareAggregate(
  database: string,
  collection: string,
  req: AggregateRequest,
  docFilters?: AppliedFilter[],
  isAdmin = false,
  subqueries?: SubqueryAccess
): IndexUse & { query: string; params: unknown[]; cap: number | null } {
  return {
    ...indexUse(collection, req.where ?? [], docFilters, undefined, null),
    ...buildAggregateSql(database, collection, req, docFilters, subqueries, isAdmin),
  }
}

type PlanNode = Record<string, unknown> & { Plans?: PlanNode[] }

/** One-line summary of EXPLAIN ANALYZE: indexes used, rows the scans touched, rows returned. */
export function summarizePlan(plan: { Plan: PlanNode; 'Execution Time': number }): string {
  const indexes = new Set<string>()
  let read = 0
  let seq = false
  const walk = (node: PlanNode) => {
    if (typeof node['Index Name'] === 'string') indexes.add(node['Index Name'])
    if (node['Node Type'] === 'Seq Scan' && String(node['Relation Name'] ?? '').startsWith('col_')) seq = true
    if (node['Relation Name']) {
      const loops = Number(node['Actual Loops'] ?? 1)
      read += (Number(node['Actual Rows'] ?? 0) + Number(node['Rows Removed by Filter'] ?? 0) + Number(node['Rows Removed by Index Recheck'] ?? 0)) * loops
    }
    for (const child of node.Plans ?? []) walk(child)
  }
  walk(plan.Plan)
  const used = [...indexes, ...(seq ? ['seq scan'] : [])].join(',') || 'none'
  return `index=${used}; read=${Math.round(read)}; returned=${plan.Plan['Actual Rows']}; ms=${plan['Execution Time'].toFixed(2)}`
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
