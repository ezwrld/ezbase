import type { Context } from 'hono'
import { sql, ensureCollection, qualifiedTable } from './db.js'

type Prim = 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array'

const MAX_DEPTH = 32
const DEFAULT_SAMPLE = 10000
const MAX_SAMPLE = 100000
const TOP_CLUSTERS = 5
const CANONICAL_THRESHOLD = 0.8

// Extraction thresholds — a shape becomes its own named interface if EITHER:
//   • it appears at 2+ distinct paths (reuse), OR
//   • it has >= EXTRACT_MIN_FIELDS fields AND >= EXTRACT_MIN_OCCURRENCES instances (complexity).
const EXTRACT_MIN_FIELDS = 3
const EXTRACT_MIN_OCCURRENCES = 10

// Literal/enum inference thresholds. A string/number field becomes a literal union when:
//   • distinct value count is bounded (otherwise it's freeform);
//   • each value is reused enough that it looks like a closed set, not unique tokens;
//   • coverage is high enough we're not just sampling a long tail.
const ENUM_MAX_DISTINCT = 12
const ENUM_MIN_OCCURRENCES = 4
const ENUM_COVERAGE = 0.95
const MAX_DISTINCT_VALUES_TRACKED = 64

// ── Public types ─────────────────────────────────────────────

export interface EnumValue {
  value: unknown
  count: number
  pct: number
}

export interface FieldStat {
  path: string
  types: Record<string, number>
  presence: number
  presencePct: number
  samples: unknown[]
  enumValues?: EnumValue[]
}

export interface Cluster {
  count: number
  pct: number
  sampleIds: string[]
  extraFields: string[]
  missingFields: string[]
  isCanonical: boolean
  label: string
}

export interface ExtractedField {
  name: string
  optional: boolean
  type: string
  presence: number
  occurrences: number
  pct: number
  typeBreakdown: Record<string, number>
  samples: unknown[]
  enumValues?: EnumValue[]
}

export interface ExtractedType {
  name: string
  source: string
  fields: ExtractedField[]
  occurrences: number
  occurrencePct: number
  paths: string[]
  isRoot: boolean
  requiredCount: number
  optionalCount: number
}

export interface AuditResult {
  database: string
  collection: string
  totalDocs: number
  scanned: number
  sampled: boolean
  fields: FieldStat[]
  clusters: Cluster[]
  types: ExtractedType[]
  canonicalInterface: string
  rootTypeName: string
  canonicalThreshold: number
}

// ── Helpers ──────────────────────────────────────────────────

function typeOf(v: unknown): Prim {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  const t = typeof v
  if (t === 'object') return 'object'
  if (t === 'string' || t === 'number' || t === 'boolean') return t
  return 'null'
}

interface PathInfo {
  presence: number
  types: Map<Prim, number>
  samples: unknown[]
  childPresence?: Map<string, number>
  // Per-value histogram for string/number leaves (used for enum inference).
  // Dropped + valueOverflow=true once distinct value count exceeds MAX_DISTINCT_VALUES_TRACKED.
  valueHistogram?: Map<string, { value: unknown; count: number }>
  valueOverflow?: boolean
}

function ensurePath(paths: Map<string, PathInfo>, path: string): PathInfo {
  let p = paths.get(path)
  if (!p) { p = { presence: 0, types: new Map(), samples: [] }; paths.set(path, p) }
  return p
}

function walk(
  value: unknown,
  path: string,
  depth: number,
  paths: Map<string, PathInfo>,
  perDocPaths: Map<string, Set<Prim>>
) {
  if (depth > MAX_DEPTH) return
  const t = typeOf(value)
  const p = ensurePath(paths, path)
  p.presence++
  p.types.set(t, (p.types.get(t) || 0) + 1)

  if (path !== '' && t !== 'object' && t !== 'array') {
    if (p.samples.length < 5 && !p.samples.some((x) => x === value)) p.samples.push(value)
  }
  if (
    path !== '' &&
    (t === 'string' || t === 'number') &&
    !p.valueOverflow &&
    (t !== 'number' || Number.isFinite(value as number))
  ) {
    if (!p.valueHistogram) p.valueHistogram = new Map()
    const key = t === 'string' ? `s:${value as string}` : `n:${value as number}`
    const ex = p.valueHistogram.get(key)
    if (ex) ex.count++
    else if (p.valueHistogram.size < MAX_DISTINCT_VALUES_TRACKED) {
      p.valueHistogram.set(key, { value, count: 1 })
    } else {
      p.valueOverflow = true
      p.valueHistogram = undefined
    }
  }
  if (path !== '') {
    let set = perDocPaths.get(path)
    if (!set) { set = new Set(); perDocPaths.set(path, set) }
    set.add(t)
  }

  if (t === 'object') {
    if (!p.childPresence) p.childPresence = new Map()
    const obj = value as Record<string, unknown>
    for (const k of Object.keys(obj)) {
      p.childPresence.set(k, (p.childPresence.get(k) || 0) + 1)
      const childPath = path === '' ? k : `${path}.${k}`
      walk(obj[k], childPath, depth + 1, paths, perDocPaths)
    }
  } else if (t === 'array') {
    for (const v of value as unknown[]) walk(v, `${path}[]`, depth + 1, paths, perDocPaths)
  }
}

function signatureForDoc(perDocPaths: Map<string, Set<Prim>>): string {
  const entries = [...perDocPaths.entries()]
    .map(([p, s]) => [p, [...s].sort().join('|')] as [string, string])
    .sort((a, b) => a[0].localeCompare(b[0]))
  return JSON.stringify(entries)
}

function formatLiteral(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return 'unknown'
}

// Decides whether a path's value distribution looks like an enum, and if so returns the
// rendered union plus the per-value distribution.
function tryInferEnum(p: PathInfo): { union: string; values: EnumValue[] } | null {
  if (!p.valueHistogram || p.valueOverflow) return null
  const types = [...p.types.keys()]
  const nonNull = types.filter((t) => t !== 'null')
  if (nonNull.length !== 1) return null
  const prim = nonNull[0]
  if (prim !== 'string' && prim !== 'number') return null
  const primaryCount = p.types.get(prim) ?? 0
  if (primaryCount < ENUM_MIN_OCCURRENCES) return null
  const distinct = p.valueHistogram.size
  if (distinct === 0 || distinct > ENUM_MAX_DISTINCT) return null
  // Each value should be reused on average (closed set vs freeform tokens)
  if (distinct * 2 > primaryCount) return null
  const totalTracked = [...p.valueHistogram.values()].reduce((s, v) => s + v.count, 0)
  if (totalTracked / primaryCount < ENUM_COVERAGE) return null

  const sorted = [...p.valueHistogram.values()].sort((a, b) => b.count - a.count)
  const union = sorted.map((v) => formatLiteral(v.value)).join(' | ')
  const values: EnumValue[] = sorted.map((v) => ({
    value: v.value,
    count: v.count,
    pct: primaryCount > 0 ? v.count / primaryCount : 0,
  }))
  return { union, values }
}

// Recursive structural signature: encodes child fields + required/optional + their own signatures.
// Identical signature ⇒ same shape ⇒ same extracted type.
function shapeSigOf(
  path: string,
  paths: Map<string, PathInfo>,
  memo: Map<string, string>
): string {
  const cached = memo.get(path)
  if (cached !== undefined) return cached
  memo.set(path, '__cycle__')
  const p = paths.get(path)
  if (!p) { memo.set(path, 'unknown'); return 'unknown' }

  // Enum narrowing participates in shape identity — a field narrowed to {'a','b'} is a
  // different shape than the same field as unconstrained string.
  // The signature must be canonical (alphabetically sorted) so identical value sets
  // produce identical signatures regardless of frequency order.
  const enumInfo = tryInferEnum(p)
  if (enumInfo && !p.types.has('object') && !p.types.has('array')) {
    const canonical = [...enumInfo.values]
      .map((v) => formatLiteral(v.value))
      .sort()
      .join('|')
    let sig = `enum(${canonical})`
    if (p.types.has('null')) sig += '|null'
    memo.set(path, sig)
    return sig
  }

  const parts: string[] = []
  const types = [...p.types.keys()].sort()
  for (const t of types) {
    if (t === 'object') {
      if (!p.childPresence || p.childPresence.size === 0) {
        parts.push('{}')
      } else {
        const objCount = p.types.get('object') ?? 0
        const fields: string[] = []
        for (const [k, c] of [...p.childPresence.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
          const required = c === objCount
          const childPath = path === '' ? k : `${path}.${k}`
          const sig = shapeSigOf(childPath, paths, memo)
          fields.push(`${k}:${required ? 'R' : 'O'}:${sig}`)
        }
        parts.push(`{${fields.join(',')}}`)
      }
    } else if (t === 'array') {
      parts.push(`[${shapeSigOf(`${path}[]`, paths, memo)}]`)
    } else {
      parts.push(t)
    }
  }
  const result = parts.join('|')
  memo.set(path, result)
  return result
}

// ── Naming ──────────────────────────────────────────────────

function pascal(s: string): string {
  return s
    .split(/[^a-zA-Z0-9]/)
    .filter(Boolean)
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join('') || 'Doc'
}

function singularize(s: string): string {
  if (s.length <= 3) return s
  if (/ies$/i.test(s)) return s.slice(0, -3) + 'y'
  if (/(?:s|x|ch|sh)es$/i.test(s)) return s.slice(0, -2)
  if (/[^s]s$/i.test(s)) return s.slice(0, -1)
  return s
}

function lastSegment(path: string): string {
  if (path === '') return ''
  const parts = path.split('.')
  let last = parts[parts.length - 1]
  while (last.endsWith('[]')) last = last.slice(0, -2)
  return last
}

function nameFromPaths(pathList: string[]): string {
  const counts = new Map<string, number>()
  for (const p of pathList) {
    const seg = lastSegment(p)
    if (seg) counts.set(seg, (counts.get(seg) || 0) + 1)
  }
  if (counts.size === 0) return 'Item'
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]
  return pascal(singularize(best))
}

function safeKey(name: string): string {
  return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name) ? name : JSON.stringify(name)
}

function uniqueName(base: string, used: Set<string>): string {
  if (!used.has(base)) { used.add(base); return base }
  let i = 2
  while (used.has(`${base}${i}`)) i++
  const result = `${base}${i}`
  used.add(result)
  return result
}

// ── Main ────────────────────────────────────────────────────

export async function runAudit(
  database: string,
  collection: string,
  sampleSize: number
): Promise<AuditResult> {
  await ensureCollection(database, collection)
  const table = qualifiedTable(database, collection)

  const countRows = await sql`SELECT COUNT(*)::int AS n FROM ${table}`
  const totalDocs = countRows[0].n as number
  const limit = Math.max(1, Math.min(sampleSize, MAX_SAMPLE))
  const sampled = totalDocs > limit

  const rows = await sql`
    SELECT id, data FROM ${table}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `

  const paths = new Map<string, PathInfo>()
  const clusters = new Map<string, { count: number; sampleIds: string[]; paths: Set<string> }>()

  for (const row of rows) {
    const id = row.id as string
    const data = row.data as unknown
    const perDocPaths = new Map<string, Set<Prim>>()
    walk(data, '', 0, paths, perDocPaths)

    const sig = signatureForDoc(perDocPaths)
    let cl = clusters.get(sig)
    if (!cl) {
      cl = { count: 0, sampleIds: [], paths: new Set(perDocPaths.keys()) }
      clusters.set(sig, cl)
    }
    cl.count++
    if (cl.sampleIds.length < 5) cl.sampleIds.push(id)
  }

  const scanned = rows.length

  // ── Flat field stats (legacy view) ──────────────────────
  const fields: FieldStat[] = []
  for (const [path, p] of paths) {
    if (path === '') continue
    const typeRecord: Record<string, number> = {}
    for (const [t, n] of p.types) typeRecord[t] = n
    const enumInfo = tryInferEnum(p)
    fields.push({
      path,
      types: typeRecord,
      presence: p.presence,
      presencePct: scanned > 0 ? p.presence / scanned : 0,
      samples: p.samples,
      enumValues: enumInfo ? enumInfo.values : undefined,
    })
  }
  fields.sort((a, b) => b.presence - a.presence || a.path.localeCompare(b.path))

  const canonicalPaths = new Set(
    fields.filter((f) => f.presencePct >= CANONICAL_THRESHOLD).map((f) => f.path)
  )

  // ── Type extraction ─────────────────────────────────────
  const memo = new Map<string, string>()
  const sigByPath = new Map<string, string>()
  const sigToObjectPaths = new Map<string, string[]>()

  for (const [path, info] of paths) {
    if (!info.types.has('object')) continue
    if (!info.childPresence || info.childPresence.size === 0) continue
    const sig = shapeSigOf(path, paths, memo)
    sigByPath.set(path, sig)
    let list = sigToObjectPaths.get(sig)
    if (!list) { list = []; sigToObjectPaths.set(sig, list) }
    list.push(path)
  }

  const extractedSigs = new Set<string>()
  const sigToName = new Map<string, string>()
  const usedNames = new Set<string>()

  // Root is always its own named type (the collection's main interface)
  const rootSig = sigByPath.get('')
  if (rootSig) {
    extractedSigs.add(rootSig)
    sigToName.set(rootSig, uniqueName(pascal(singularize(collection)), usedNames))
  }

  // Score and decide other extractions
  const candidates = [...sigToObjectPaths.entries()]
    .filter(([sig]) => sig !== rootSig)
    .map(([sig, pathList]) => {
      const occurrences = pathList.reduce(
        (s, p) => s + (paths.get(p)!.types.get('object') ?? 0),
        0
      )
      const fieldCount = paths.get(pathList[0])!.childPresence!.size
      return { sig, pathList, occurrences, fieldCount }
    })
    .sort((a, b) => b.pathList.length - a.pathList.length || b.occurrences - a.occurrences)

  for (const c of candidates) {
    const reused = c.pathList.length >= 2
    const complex = c.fieldCount >= EXTRACT_MIN_FIELDS && c.occurrences >= EXTRACT_MIN_OCCURRENCES
    if (reused || complex) {
      extractedSigs.add(c.sig)
      sigToName.set(c.sig, uniqueName(nameFromPaths(c.pathList), usedNames))
    }
  }

  // ── Rendering ───────────────────────────────────────────

  function renderType(path: string, depth: number, allowExtractedRef: boolean): string {
    const p = paths.get(path)
    if (!p) return 'unknown'

    // Enum narrowing replaces the plain primitive type
    const enumInfo = tryInferEnum(p)
    if (enumInfo && !p.types.has('object') && !p.types.has('array')) {
      return p.types.has('null') ? `${enumInfo.union} | null` : enumInfo.union
    }

    const types = [...p.types.keys()]
    const nullable = types.includes('null')
    const reps: string[] = []

    for (const t of types) {
      if (t === 'null') continue
      if (t === 'object') {
        const sig = sigByPath.get(path)
        if (sig && extractedSigs.has(sig) && allowExtractedRef) {
          reps.push(sigToName.get(sig)!)
        } else {
          reps.push(renderObjectInline(path, depth))
        }
      } else if (t === 'array') {
        const inner = renderType(`${path}[]`, depth, true)
        reps.push(
          inner.includes(' | ') || inner.includes('\n') ? `Array<${inner}>` : `${inner}[]`
        )
      } else {
        reps.push(t)
      }
    }

    let result = reps.length === 0 ? 'unknown' : [...new Set(reps)].sort().join(' | ')
    if (nullable) result = result === 'unknown' ? 'null' : `${result} | null`
    return result
  }

  function renderObjectInline(path: string, depth: number): string {
    const p = paths.get(path)!
    if (!p.childPresence || p.childPresence.size === 0) return 'Record<string, unknown>'
    const objCount = p.types.get('object') ?? 0
    const indent = '  '.repeat(depth + 1)
    const close = '  '.repeat(depth)
    const lines: string[] = []
    for (const [k, c] of [...p.childPresence.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const required = c === objCount
      const opt = required ? '' : '?'
      const childPath = path === '' ? k : `${path}.${k}`
      const typeStr = renderType(childPath, depth + 1, true)
      lines.push(`${indent}${safeKey(k)}${opt}: ${typeStr}`)
    }
    return `{\n${lines.join('\n')}\n${close}}`
  }

  function buildExtractedType(sig: string): ExtractedType {
    const name = sigToName.get(sig)!
    const pathList = sigToObjectPaths.get(sig)!
    const repPath = pathList[0]
    const p = paths.get(repPath)!
    const objCount = p.types.get('object') ?? 0
    const isRoot = sig === rootSig

    const fields: ExtractedField[] = []
    const lines: string[] = []
    let requiredCount = 0
    let optionalCount = 0

    for (const [k, c] of [...p.childPresence!.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const required = c === objCount
      const childPath = repPath === '' ? k : `${repPath}.${k}`
      const childInfo = paths.get(childPath)
      const typeStr = renderType(childPath, 1, true)
      const typeBreakdown: Record<string, number> = {}
      if (childInfo) for (const [t, n] of childInfo.types) typeBreakdown[t] = n

      const childEnum = childInfo ? tryInferEnum(childInfo) : null
      fields.push({
        name: k,
        optional: !required,
        type: typeStr,
        presence: c,
        occurrences: objCount,
        pct: objCount > 0 ? c / objCount : 0,
        typeBreakdown,
        samples: childInfo?.samples ?? [],
        enumValues: childEnum ? childEnum.values : undefined,
      })

      if (required) requiredCount++
      else optionalCount++
      lines.push(`  ${safeKey(k)}${required ? '' : '?'}: ${typeStr}`)
    }

    const source = `interface ${name} {\n${lines.join('\n')}\n}`

    return {
      name,
      source,
      fields,
      occurrences: objCount,
      occurrencePct: scanned > 0 ? objCount / scanned : 0,
      paths: pathList,
      isRoot,
      requiredCount,
      optionalCount,
    }
  }

  const types: ExtractedType[] = [...extractedSigs]
    .map(buildExtractedType)
    .sort((a, b) => {
      if (a.isRoot) return -1
      if (b.isRoot) return 1
      return b.occurrences - a.occurrences
    })

  const canonicalInterface = types.map((t) => t.source).join('\n\n')

  // ── Clusters ────────────────────────────────────────────
  const sortedClusters = [...clusters.entries()]
    .map(([sig, c]) => ({ sig, ...c }))
    .sort((a, b) => b.count - a.count)
  const top = sortedClusters.slice(0, TOP_CLUSTERS)
  const rest = sortedClusters.slice(TOP_CLUSTERS)

  const clusterList: Cluster[] = top.map((c) => {
    const extra = [...c.paths].filter((p) => !canonicalPaths.has(p)).sort()
    const missing = [...canonicalPaths].filter((p) => !c.paths.has(p)).sort()
    const isCanonical = extra.length === 0 && missing.length === 0
    let label: string
    if (isCanonical) label = 'Canonical shape'
    else if (extra.length && !missing.length) label = `Adds ${extra.length} field${extra.length === 1 ? '' : 's'}`
    else if (missing.length && !extra.length) label = `Missing ${missing.length} field${missing.length === 1 ? '' : 's'}`
    else label = `Differs by ${extra.length + missing.length} fields`
    return {
      count: c.count,
      pct: scanned > 0 ? c.count / scanned : 0,
      sampleIds: c.sampleIds,
      extraFields: extra,
      missingFields: missing,
      isCanonical,
      label,
    }
  })

  if (rest.length > 0) {
    const restCount = rest.reduce((s, c) => s + c.count, 0)
    clusterList.push({
      count: restCount,
      pct: scanned > 0 ? restCount / scanned : 0,
      sampleIds: rest.flatMap((c) => c.sampleIds).slice(0, 5),
      extraFields: [],
      missingFields: [],
      isCanonical: false,
      label: `${rest.length} other shape${rest.length === 1 ? '' : 's'}`,
    })
  }

  return {
    database,
    collection,
    totalDocs,
    scanned,
    sampled,
    fields,
    clusters: clusterList,
    types,
    canonicalInterface,
    rootTypeName: types[0]?.name ?? pascal(singularize(collection)),
    canonicalThreshold: CANONICAL_THRESHOLD,
  }
}

export async function auditHandler(c: Context, database: string) {
  const role = c.get('role') || 'anonymous'
  if (role !== 'admin') {
    return c.json(
      { error: role === 'anonymous' ? 'Unauthorized' : 'Forbidden' },
      role === 'anonymous' ? 401 : 403
    )
  }
  const collection = c.req.param('collection')!
  const sampleParam = c.req.query('sample')
  const sample = sampleParam ? parseInt(sampleParam, 10) || DEFAULT_SAMPLE : DEFAULT_SAMPLE
  const result = await runAudit(database, collection, sample)
  return c.json(result)
}
