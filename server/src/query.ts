import type { AppliedFilter } from './rules.js'
import { ensureQueryIndexes } from './db.js'

function mapOp(op: string): string {
  const ops: Record<string, string> = {
    '==': '=',
    '!=': '!=',
    '<': '<',
    '>': '>',
    '<=': '<=',
    '>=': '>=',
  }
  return ops[op] || '='
}

export function sanitizeField(field: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field)) {
    throw new Error(`Invalid field name: ${field}`)
  }
  return field
}

export function parseFields(value?: string): string[] | undefined {
  if (value === undefined) return undefined

  const fields = value.split(',').map((field) => field.trim())
  if (fields.length === 0 || fields.length > 64 || fields.some((field) => !field)) {
    throw new Error('fields must contain 1 to 64 comma-separated field names')
  }

  return Array.from(new Set(fields.map(sanitizeField)))
}

export function autoIndexEnabled(): boolean {
  return process.env.EZBASE_AUTO_INDEX !== 'false'
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

export type WhereClause = [string, string, unknown]

export function parseWhere(whereParam?: string): WhereClause[] {
  if (!whereParam) return []
  const parsed = JSON.parse(whereParam)
  if (!Array.isArray(parsed)) throw new Error('where must be an array')
  return parsed as WhereClause[]
}

export function collectIndexHints(
  wheres: WhereClause[],
  orderBy?: string,
  docFilters?: AppliedFilter[]
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
  if (orderBy) {
    orderField = timestampColumn(orderBy) ?? sanitizeField(orderBy)
    if (!timestampColumn(orderBy)) addJson(orderField)
  } else {
    orderField = 'created_at'
  }

  return { eqFields, jsonFields, orderField }
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

function appendEquality(
  query: string,
  params: unknown[],
  field: string,
  value: unknown,
  negate: boolean,
  useJsonb: boolean
): string {
  const idx = params.length + 1
  if (useJsonb) {
    params.push(value)
    let cast = 'text'
    if (typeof value === 'number') cast = 'numeric'
    else if (typeof value === 'boolean') cast = 'boolean'
    const pred = `data->'${field}' ${negate ? 'IS DISTINCT FROM' : '='} to_jsonb($${idx}::${cast})`
    return `${query} AND ${pred}`
  }
  params.push(JSON.stringify({ [field]: value }))
  if (negate) return `${query} AND NOT data @> ($${idx}::text)::jsonb`
  return `${query} AND data @> ($${idx}::text)::jsonb`
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
  useJsonbPredicates = autoIndexEnabled()
): { query: string; params: unknown[] } {
  void isAdmin
  const DEFAULT_LIMIT = parseInt(process.env.EZBASE_DEFAULT_LIMIT || '100', 10)
  const MAX_LIMIT = parseInt(process.env.EZBASE_MAX_LIMIT || '10000', 10)

  const resolveLimit = (limit: string | undefined): number => {
    if (limit !== undefined && limit !== '') {
      const n = parseInt(limit, 10)
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error('limit must be a positive integer')
      }
      return Math.min(n, MAX_LIMIT)
    }
    return DEFAULT_LIMIT
  }

  let query = `SELECT ${selectClause(fields)} FROM db_${database}.col_${collection} WHERE true`
  const params: unknown[] = []

  if (docFilters) {
    for (const f of docFilters) {
      const field = sanitizeField(f.field)
      if (f.values) {
        if (useJsonbPredicates) {
          const placeholders: string[] = []
          for (const value of f.values) {
            params.push(value)
            placeholders.push(`to_jsonb($${params.length}::text)`)
          }
          query += ` AND data->'${field}' IN (${placeholders.join(', ')})`
        } else {
          params.push(f.values)
          query += ` AND data->>'${field}' = ANY($${params.length})`
        }
      } else if (f.value !== null) {
        query = appendEquality(query, params, field, f.value, false, useJsonbPredicates)
      }
    }
  }

  const wheres = parseWhere(whereParam)
  for (const [field, op, value] of wheres) {
    const sqlOp = mapOp(op)
    const colName = timestampColumn(field)

    if (colName) {
      params.push(value)
      query += ` AND ${colName} ${sqlOp} $${params.length}`
      continue
    }

    const jsonField = sanitizeField(field)

    if (op === '==' || op === '!=') {
      query = appendEquality(query, params, jsonField, value, op === '!=', useJsonbPredicates)
      continue
    }

    const idx = params.length + 1
    if (typeof value === 'number') {
      if (useJsonbPredicates) {
        params.push(value)
        query += ` AND data->'${jsonField}' ${sqlOp} to_jsonb($${idx}::numeric)`
      } else {
        params.push(value)
        query += ` AND (data->>'${jsonField}')::numeric ${sqlOp} $${idx}`
      }
    } else if (typeof value === 'boolean') {
      query = appendEquality(query, params, jsonField, value, false, useJsonbPredicates)
    } else if (useJsonbPredicates) {
      params.push(value)
      query += ` AND data->'${jsonField}' ${sqlOp} to_jsonb($${idx}::text)`
    } else {
      params.push(value)
      query += ` AND data->>'${jsonField}' ${sqlOp} $${idx}`
    }
  }

  if (orderBy) {
    const dir = (order || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC'
    const colName = timestampColumn(orderBy)
    if (colName) {
      query += ` ORDER BY ${colName} ${dir}`
    } else {
      query += ` ORDER BY data->'${sanitizeField(orderBy)}' ${dir}`
    }
  } else {
    query += ' ORDER BY created_at DESC'
  }

  const limit = resolveLimit(limitParam)
  params.push(limit)
  query += ` LIMIT $${params.length}`

  if (offsetParam) {
    const n = parseInt(offsetParam, 10)
    if (n > 0) {
      params.push(n)
      query += ` OFFSET $${params.length}`
    }
  }

  return { query, params }
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
  isAdmin = false
): Promise<{ query: string; params: unknown[] }> {
  const useJsonb = autoIndexEnabled()
  if (shouldEnsureQueryIndexes(isAdmin)) {
    const hints = collectIndexHints(parseWhere(whereParam), orderBy, docFilters)
    await ensureQueryIndexes(database, collection, hints)
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
    useJsonb
  )
}
