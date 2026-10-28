import { qualifiedTableName, sanitizeField, sql } from './db.js'

/**
 * What a collection's documents actually look like: every field path (three levels
 * deep, arrays as `path[]`), the JSON types each holds and in how many documents,
 * the values of enum-like fields, the distinct top-level shapes, the inconsistencies
 * worth cleaning up, and the TypeScript interface the data implies. Computed in
 * Postgres over a repeatable sample so a large collection answers in about a second.
 */

const SAMPLE_SIZE = 25_000
const MIN_SAMPLE = 5_000
const WALK_TARGET = 500_000
const MAX_DEPTH = 3
const ENUM_MAX_VALUES = 12
const TIMEOUT_MS = 20_000

type JsonType = 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array'

export type FieldShape = {
  path: string
  present: number
  types: Partial<Record<JsonType, number>>
  values?: { value: string; count: number }[]
}

export type ShapeIssue = {
  path: string
  kind: 'type-conflict' | 'null-and-missing'
  detail: string
  script: string
}

export type CollectionShapes = {
  collection: string
  total: number
  sampled: number
  fields: FieldShape[]
  shapes: { keys: string[]; count: number }[]
  shapeCount: number
  groupedBy: string | null
  groups: { value: string; documents: number; shapes: number }[]
  issues: ShapeIssue[]
  typescript: string
}

export async function analyzeShapes(database: string, collection: string, by?: string): Promise<CollectionShapes> {
  const table = qualifiedTableName(database, collection)
  if (by) sanitizeField(by)

  return sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL statement_timeout = ${TIMEOUT_MS}`)
    await tx.unsafe(`SET LOCAL work_mem = '64MB'`)
    const [{ total }] = await tx.unsafe(`SELECT count(*)::int AS total FROM ${table}`)
    const percent = total <= SAMPLE_SIZE ? 100 : Math.min(100, (SAMPLE_SIZE / total) * 100 * 1.2)
    await tx.unsafe(`CREATE TEMP TABLE shape_sample ON COMMIT DROP AS
      SELECT id, data, (SELECT coalesce(string_agg(k, ',' ORDER BY k), '') FROM jsonb_object_keys(data) k) AS keys
      FROM ${table} TABLESAMPLE SYSTEM (${percent}) REPEATABLE (1) LIMIT ${SAMPLE_SIZE}`)
    // Wide documents walk into many more values; keep the walk near WALK_TARGET values.
    const [{ perDoc }] = await tx.unsafe(`${walkSql('(SELECT id, data FROM shape_sample LIMIT 300)')} SELECT (count(*)::float / greatest(count(DISTINCT id), 1)) AS "perDoc" FROM walk`)
    const keep = Math.max(MIN_SAMPLE, Math.min(SAMPLE_SIZE, Math.round(WALK_TARGET / Math.max(1, perDoc))))
    await tx.unsafe(`DELETE FROM shape_sample WHERE id NOT IN (SELECT id FROM shape_sample LIMIT ${keep})`)
    // Array elements repeat within a document; deduplicating them here makes every count below a document count.
    await tx.unsafe(`CREATE TEMP TABLE shape_walk ON COMMIT DROP AS ${walkSql('shape_sample')},
      typed AS (
        SELECT id, path, strpos(path, '[]') > 0 AS arr, jsonb_typeof(value) AS type,
          CASE WHEN jsonb_typeof(value) IN ('string', 'boolean') THEN value #>> '{}' END AS text
        FROM walk
      )
      SELECT id, path, type, text FROM typed WHERE NOT arr
      UNION ALL
      SELECT DISTINCT id, path, type, text FROM typed WHERE arr`)

    const [{ sampled }] = await tx.unsafe(`SELECT count(*)::int AS sampled FROM shape_sample`)
    const typeRows = await tx.unsafe(`
      SELECT path, type, count(DISTINCT id)::int AS docs FROM shape_walk WHERE strpos(path, '[]') > 0 GROUP BY path, type
      UNION ALL
      SELECT path, type, count(*)::int FROM shape_walk WHERE strpos(path, '[]') = 0 GROUP BY path, type`)
    const valueRows = await tx.unsafe(`
      WITH vals AS (SELECT path, text AS value, count(*)::int AS docs FROM shape_walk WHERE text IS NOT NULL GROUP BY path, text),
      card AS (SELECT path FROM vals GROUP BY path HAVING count(*) <= ${ENUM_MAX_VALUES} AND sum(docs) >= 20 * count(*))
      SELECT vals.* FROM vals JOIN card USING (path) ORDER BY path, docs DESC`)
    const shapeRows = await tx.unsafe(`
      SELECT keys, count(*)::int AS docs, count(*) OVER ()::int AS distinct_shapes FROM shape_sample GROUP BY keys ORDER BY docs DESC LIMIT 25`)

    // A document holds one type per path, so presence is the sum; in arrays it is the most common element type's count.
    const fields = new Map<string, FieldShape>()
    for (const row of typeRows) {
      const field: FieldShape = fields.get(row.path) ?? { path: row.path, present: 0, types: {} }
      field.types[row.type as JsonType] = row.docs
      field.present = row.path.includes('[]') ? Math.max(field.present, row.docs) : field.present + row.docs
      fields.set(row.path, field)
    }
    for (const row of valueRows) {
      const field = fields.get(row.path)!
      ;(field.values ??= []).push({ value: row.value, count: row.docs })
    }

    const ordered = [...fields.values()].sort((a, b) => b.present - a.present || a.path.localeCompare(b.path))
    const shapeCount = shapeRows[0]?.distinct_shapes ?? 0
    const groupedBy = by ?? (shapeCount > 1 ? await pickDiscriminator(tx, ordered, sampled) : null)
    const groups = groupedBy ? await groupShapes(tx, groupedBy) : []

    return {
      collection,
      total,
      sampled,
      fields: ordered,
      shapes: shapeRows.map((r) => ({ keys: r.keys ? (r.keys as string).split(',') : [], count: r.docs })),
      shapeCount,
      groupedBy,
      groups,
      issues: findIssues(database, collection, ordered, sampled),
      typescript: toTypeScript(collection, ordered, sampled),
    }
  })
}

/** Every field path of every document in `source`, three levels deep, arrays as `path[]`. */
function walkSql(source: string): string {
  return `WITH RECURSIVE walk(id, path, value, depth) AS (
      SELECT s.id, e.key, e.value, 1 FROM ${source} s, jsonb_each(s.data) e
      UNION ALL
      SELECT w.id, c.path, c.value, w.depth + 1
      FROM walk w, LATERAL (
        SELECT w.path || '.' || e.key AS path, e.value
          FROM jsonb_each(CASE WHEN jsonb_typeof(w.value) = 'object' THEN w.value END) e
        UNION ALL
        SELECT w.path || '[]', a.value
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(w.value) = 'array' THEN w.value END) a
      ) c
      WHERE w.depth < ${MAX_DEPTH}
    )`
}

/**
 * The top-level string field on every document, with 2–12 values, that best explains why
 * shapes differ: the one whose groups are most uniform (fewest shapes per document, weighted).
 */
async function pickDiscriminator(tx: any, fields: FieldShape[], sampled: number): Promise<string | null> {
  const candidates = fields
    .filter((f) => !f.path.includes('.') && !f.path.includes('[]') && f.present === sampled && f.values && f.values.length >= 2)
    .sort((a, b) => a.values!.length - b.values!.length)
    .slice(0, 6)
  let best: { path: string; score: number } | null = null
  for (const field of candidates) {
    const groups = await groupShapes(tx, field.path)
    const score = groups.reduce((sum: number, g: { documents: number; shapes: number }) => sum + g.shapes * g.documents, 0) / sampled
    if (!best || score < best.score) best = { path: field.path, score }
  }
  return best?.path ?? null
}

async function groupShapes(tx: any, by: string) {
  const rows = await tx.unsafe(
    `SELECT coalesce(data #>> $1, 'null') AS value, count(*)::int AS documents, count(DISTINCT keys)::int AS shapes
     FROM shape_sample GROUP BY 1 ORDER BY documents DESC LIMIT 20`,
    [`{${by.split('.').join(',')}}`]
  )
  return rows.map((r: any) => ({ value: r.value, documents: r.documents, shapes: r.shapes }))
}

function findIssues(database: string, collection: string, fields: FieldShape[], sampled: number): ShapeIssue[] {
  const ref = database === 'default' ? `ez.collection(${JSON.stringify(collection)})` : `ez.database(${JSON.stringify(database)}).collection(${JSON.stringify(collection)})`
  const byPath = new Map(fields.map((f) => [f.path, f]))
  const issues: ShapeIssue[] = []
  for (const f of fields) {
    if (f.path.includes('[]')) continue
    const parent = f.path.includes('.') ? byPath.get(f.path.slice(0, f.path.lastIndexOf('.'))) : null
    const scope = parent ? parent.types.object ?? 0 : sampled
    const types = Object.entries(f.types) as [JsonType, number][]
    const concrete = types.filter(([t]) => t !== 'null').sort((a, b) => b[1] - a[1])
    const nulls = f.types.null ?? 0
    const missing = scope - f.present
    const n = (v: number) => v.toLocaleString('en-US')
    if (concrete.length > 1) {
      const [main, ...rest] = concrete
      issues.push({
        path: f.path,
        kind: 'type-conflict',
        detail: concrete.map(([t, v]) => `${n(v)} ${t}`).join(' · '),
        script: conflictScript(ref, collection, f.path, main[0], rest.map(([t]) => t)),
      })
    } else if (nulls > 0 && missing > 0) {
      issues.push({
        path: f.path,
        kind: 'null-and-missing',
        detail: `${n(nulls)} null · ${n(missing)} missing${concrete[0] ? ` · ${n(concrete[0][1])} ${concrete[0][0]}` : ''}`,
        script: missingScript(ref, collection, f.path),
      })
    }
  }
  return issues.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'type-conflict' ? -1 : 1))
}

/** Reads the top-level field, changes `path` inside it, and writes the top-level field back. */
function patchScript(ref: string, path: string, comment: string, test: string, skip: string, next: string): string {
  const [top, ...rest] = path.split('.')
  const lines = [comment, `const docs = await ${ref}.select(${JSON.stringify(top)}).get()`, `for (const doc of docs) {`]
  if (rest.length === 0) {
    lines.push(
      `  const has = ${JSON.stringify(top)} in doc.data, value = doc.data[${JSON.stringify(top)}]`,
      `  if (${test}) await ${ref}.doc(doc.id).update({ ${safeKey(top)}: ${next} })`
    )
  } else {
    const parentPath = rest.slice(0, -1).map((k) => `?.[${JSON.stringify(k)}]`).join('')
    const key = JSON.stringify(rest[rest.length - 1])
    lines.push(
      `  const root = structuredClone(doc.data[${JSON.stringify(top)}])`,
      `  const parent = root${parentPath}`,
      `  if (!parent || typeof parent !== 'object') continue`,
      `  const has = ${key} in parent, value = parent[${key}]`,
      `  if (${skip}) continue`,
      `  parent[${key}] = ${next}`,
      `  await ${ref}.doc(doc.id).update({ ${safeKey(top)}: root })`
    )
  }
  lines.push(`}`)
  return lines.join('\n')
}

function missingScript(ref: string, collection: string, path: string): string {
  return patchScript(ref, path, `// Give every ${collection} document an explicit ${path}: null where it is absent.`, '!has', 'has', 'null')
}

function conflictScript(ref: string, collection: string, path: string, main: JsonType, others: JsonType[]): string {
  const convert: Partial<Record<JsonType, string>> = {
    number: 'Number(value)',
    string: 'String(value)',
    boolean: "!(value === 0 || value === '0' || value === 'false' || value === '')",
  }
  // Values that cannot become the target type are left for a person to look at.
  const unconvertible: Partial<Record<JsonType, string>> = {
    number: ' || Number.isNaN(Number(value))',
  }
  const jsType = main === 'array' || main === 'object' ? 'object' : main
  return patchScript(
    ref,
    path,
    `// Store ${path} as ${main} in every ${collection} document (some hold ${others.join(', ')}).`,
    `has && value !== null && typeof value !== ${JSON.stringify(jsType)}`,
    `!has || value === null || typeof value === ${JSON.stringify(jsType)}${unconvertible[main] ?? ''}`,
    convert[main] ?? 'value'
  )
}

function safeKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key)
}

// ── TypeScript ───────────────────────────────────────────────

function typeName(collection: string): string {
  const words = collection.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean)
  if (words.length) {
    const last = words[words.length - 1]
    words[words.length - 1] = last.endsWith('ies') ? last.slice(0, -3) + 'y' : last.endsWith('ses') ? last.slice(0, -2) : last.endsWith('s') && !last.endsWith('ss') ? last.slice(0, -1) : last
  }
  const name = words.map((w) => w[0].toUpperCase() + w.slice(1)).join('')
  return /^[A-Za-z]/.test(name) ? name : `Doc${name}`
}

function toTypeScript(collection: string, fields: FieldShape[], sampled: number): string {
  const byPath = new Map(fields.map((f) => [f.path, f]))
  const children = (prefix: string) =>
    fields.filter((f) => {
      const rest = prefix ? (f.path.startsWith(prefix + '.') ? f.path.slice(prefix.length + 1) : null) : f.path
      return rest !== null && rest !== '' && !rest.includes('.') && !rest.includes('[]')
    })

  const render = (field: FieldShape, parentPresent: number, indent: string): string => {
    const key = field.path.split('.').pop()!
    const optional = field.present < parentPresent ? '?' : ''
    return `${indent}${safeKey(key)}${optional}: ${typeOf(field, indent)}`
  }

  const typeOf = (field: FieldShape, indent: string): string => {
    const parts: string[] = []
    for (const type of Object.keys(field.types) as JsonType[]) {
      if (type === 'string' && field.values && field.values.length <= ENUM_MAX_VALUES && !field.types.number) {
        parts.push(...field.values.filter((v) => v.value !== null).map((v) => JSON.stringify(v.value)))
      } else if (type === 'object') {
        const kids = children(field.path)
        const depth = field.path.split('.').length
        parts.push(
          kids.length && depth < MAX_DEPTH
            ? `{\n${kids.map((k) => render(k, field.types.object ?? field.present, indent + '  ')).join('\n')}\n${indent}}`
            : 'Record<string, unknown>'
        )
      } else if (type === 'array') {
        const element = byPath.get(`${field.path}[]`)
        const inner = element ? typeOf(element, indent) : 'unknown'
        parts.push(inner.includes('|') || inner.includes('\n') ? `Array<${inner}>` : `${inner}[]`)
      } else {
        parts.push(type)
      }
    }
    return [...new Set(parts)].join(' | ') || 'unknown'
  }

  const top = children('')
  return `interface ${typeName(collection)} {\n${top.map((f) => render(f, sampled, '  ')).join('\n')}\n}`
}
