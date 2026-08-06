import { Hono } from 'hono'
import type { Context } from 'hono'
import * as fs from 'node:fs'

// ── Types ─────────────────────────────────────────────────────

export type FilterMap = Record<string, string>

export interface CollectionRule {
  access: string
  filter?: FilterMap
}

/** A permission level: string or { access, filter? } */
export type PermissionLevel = string | CollectionRule

export interface ReadWriteRule {
  read?: PermissionLevel
  write?: PermissionLevel
}

export type RuleValue = PermissionLevel | ReadWriteRule
export type DefaultRule = string | { read?: string; write?: string }

/** Bucket rule: a single level, or separate read/write levels (no filters) */
export type BucketRule = string | { read?: string; write?: string }

export interface RulesFile {
  default: DefaultRule
  collections?: Record<string, RuleValue>
  buckets?: Record<string, BucketRule>
}

export interface ResolvedRule {
  access: string
  filters: Array<{ field: string; authPath: string }>
}

export interface AppliedFilter {
  field: string
  value: string | null
  values: string[] | null
}

// ── State ─────────────────────────────────────────────────────

const RULES_PATH = process.env.RULES_PATH || '/data/rules.json'

// Secure default for fresh instances: anyone can read, writes need a signed-in
// user (or the admin key). Set `"default": "public"` in rules.json to open writes.
const DEFAULT_RULES: RulesFile = { default: { read: 'public', write: 'authenticated' } }

let currentRules: RulesFile = DEFAULT_RULES
let readonly = false

function warnIfPublicWrites(rules: RulesFile) {
  const def = rules.default
  const write = typeof def === 'string' ? def : def.write ?? 'public'
  if (write === 'public') {
    console.warn(
      'ezbase: WARNING — default write access is "public": anyone can create, modify, and delete documents in collections without explicit rules. Set {"default":{"read":"public","write":"authenticated"}} in rules.json unless this is intentional.'
    )
  }
}

// ── Validation ────────────────────────────────────────────────

const VALID_LEVELS = ['public', 'authenticated', 'admin', 'owner']
const AUTH_PATH_RE = /^(auth\.id|claims\.[a-zA-Z][a-zA-Z0-9_.]*)$/

export function isValidLevel(level: string): boolean {
  if (VALID_LEVELS.includes(level)) return true
  if (/^role:[a-zA-Z][a-zA-Z0-9_]*$/.test(level)) return true
  return false
}

/** Check if a value is a ReadWriteRule (has read/write keys, no access key) */
function isReadWriteRule(value: unknown): value is ReadWriteRule {
  if (typeof value !== 'object' || value === null) return false
  const obj = value as Record<string, unknown>
  return ('read' in obj || 'write' in obj) && !('access' in obj)
}

/** Validate a single permission level: string or { access, filter? } */
function validatePermissionLevel(value: unknown): boolean {
  if (typeof value === 'string') {
    return isValidLevel(value)
  }
  if (typeof value === 'object' && value !== null) {
    const rule = value as Record<string, unknown>
    if (typeof rule.access !== 'string' || !isValidLevel(rule.access)) return false
    if (rule.filter !== undefined) {
      if (typeof rule.filter !== 'object' || rule.filter === null) return false
      for (const [, authPath] of Object.entries(rule.filter as Record<string, unknown>)) {
        if (typeof authPath !== 'string' || !AUTH_PATH_RE.test(authPath)) return false
      }
    }
    return true
  }
  return false
}

export function validateRules(rules: unknown): rules is RulesFile {
  if (!rules || typeof rules !== 'object') return false
  const r = rules as Record<string, unknown>

  // Validate default: string or { read?: string, write?: string }
  if (typeof r.default === 'string') {
    if (!isValidLevel(r.default)) return false
  } else if (typeof r.default === 'object' && r.default !== null) {
    const def = r.default as Record<string, unknown>
    // default read/write must be strings (not objects) if present
    if ('read' in def && (typeof def.read !== 'string' || !isValidLevel(def.read))) return false
    if ('write' in def && (typeof def.write !== 'string' || !isValidLevel(def.write))) return false
    // Must have at least read or write
    if (!('read' in def) && !('write' in def)) return false
  } else {
    return false
  }

  if (r.collections !== undefined) {
    if (typeof r.collections !== 'object' || r.collections === null) return false
    for (const [, value] of Object.entries(r.collections as Record<string, unknown>)) {
      if (typeof value === 'string') {
        if (!isValidLevel(value)) return false
      } else if (typeof value === 'object' && value !== null) {
        if (isReadWriteRule(value)) {
          // ReadWriteRule: validate read and write if present
          const rw = value as ReadWriteRule
          if (rw.read !== undefined && !validatePermissionLevel(rw.read)) return false
          if (rw.write !== undefined && !validatePermissionLevel(rw.write)) return false
        } else {
          // CollectionRule: { access, filter? }
          if (!validatePermissionLevel(value)) return false
        }
      } else {
        return false
      }
    }
  }

  if (r.buckets !== undefined) {
    if (typeof r.buckets !== 'object' || r.buckets === null) return false
    for (const [, value] of Object.entries(r.buckets as Record<string, unknown>)) {
      if (typeof value === 'string') {
        if (!isValidLevel(value)) return false
      } else if (typeof value === 'object' && value !== null) {
        const rw = value as Record<string, unknown>
        if ('read' in rw && (typeof rw.read !== 'string' || !isValidLevel(rw.read))) return false
        if ('write' in rw && (typeof rw.write !== 'string' || !isValidLevel(rw.write))) return false
        if (!('read' in rw) && !('write' in rw)) return false
      } else {
        return false
      }
    }
  }

  return true
}

// ── Core functions ────────────────────────────────────────────

export async function loadRules() {
  try {
    if (!fs.existsSync(RULES_PATH)) {
      try {
        fs.writeFileSync(RULES_PATH, JSON.stringify(DEFAULT_RULES, null, 2) + '\n')
        console.log('ezbase: created default rules.json (public read, authenticated write)')
      } catch (err: any) {
        if (err.code === 'EROFS' || err.code === 'EACCES') {
          readonly = true
          console.log('ezbase: rules.json path not writable, running read-only')
          return
        }
        throw err
      }
    }

    const raw = fs.readFileSync(RULES_PATH, 'utf-8')
    const parsed = JSON.parse(raw)
    if (!validateRules(parsed)) {
      console.warn('ezbase: invalid rules.json, using defaults')
      return
    }
    currentRules = parsed
    warnIfPublicWrites(currentRules)

    // Check writability
    try {
      fs.accessSync(RULES_PATH, fs.constants.W_OK)
    } catch {
      readonly = true
    }

    console.log(`ezbase: loaded rules.json (readonly=${readonly})`)
  } catch (err) {
    console.warn('ezbase: failed to load rules.json, using defaults:', err)
  }
}

export function watchRules() {
  try {
    let debounce: ReturnType<typeof setTimeout> | null = null
    fs.watch(RULES_PATH, () => {
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => {
        try {
          const raw = fs.readFileSync(RULES_PATH, 'utf-8')
          const parsed = JSON.parse(raw)
          if (validateRules(parsed)) {
            currentRules = parsed
            console.log('ezbase: rules.json reloaded')
          } else {
            console.warn('ezbase: invalid rules.json change ignored')
          }
        } catch (err) {
          console.warn('ezbase: failed to reload rules.json:', err)
        }
      }, 200)
    })
  } catch {
    // File watching not available — no hot-reload
  }
}

export function getRules(): RulesFile {
  return currentRules
}

export function isRulesReadonly(): boolean {
  return readonly
}

export function writeRules(rules: RulesFile) {
  if (readonly) throw new Error('Rules file is read-only (mounted volume)')
  if (!validateRules(rules)) throw new Error('Invalid rules')
  fs.writeFileSync(RULES_PATH, JSON.stringify(rules, null, 2) + '\n')
  currentRules = rules
}

// ── Rule resolution ───────────────────────────────────────────

/** Resolve a single PermissionLevel (string or { access, filter? }) into a ResolvedRule */
function resolvePermissionLevel(level: PermissionLevel): ResolvedRule {
  if (typeof level === 'string') {
    if (level === 'owner') {
      return { access: 'authenticated', filters: [{ field: 'userId', authPath: 'auth.id' }] }
    }
    return { access: level, filters: [] }
  }

  const filters = level.filter
    ? Object.entries(level.filter).map(([field, authPath]) => ({ field, authPath }))
    : []
  return { access: level.access, filters }
}

/** Resolve the default rule for a given action */
function resolveDefault(action: 'read' | 'write'): ResolvedRule {
  const def = currentRules.default
  if (typeof def === 'string') {
    return resolvePermissionLevel(def)
  }
  // { read?: string, write?: string }
  const level = def[action] ?? 'public'
  return resolvePermissionLevel(level)
}

export function getRuleForCollection(
  collection: string,
  action: 'read' | 'write' = 'read'
): ResolvedRule {
  const rule = currentRules.collections?.[collection]

  if (!rule) {
    return resolveDefault(action)
  }

  // String level — same for both read and write
  if (typeof rule === 'string') {
    return resolvePermissionLevel(rule)
  }

  // ReadWriteRule: { read?, write? }
  if (isReadWriteRule(rule)) {
    const level = rule[action]
    if (level === undefined) {
      // Fall back to default for this action
      return resolveDefault(action)
    }
    return resolvePermissionLevel(level)
  }

  // CollectionRule: { access, filter? } — same for both actions
  return resolvePermissionLevel(rule)
}

export function getBucketAccess(bucket: string, action: 'read' | 'write' | 'delete' = 'read'): string {
  const side = action === 'read' ? 'read' : 'write'

  const rule = currentRules.buckets?.[bucket]
  if (typeof rule === 'string') return rule
  if (rule && rule[side]) return rule[side]!

  // Missing side / unlisted bucket falls back to the default — reads use the
  // read level, writes/deletes the write level (mirrors collection fallback)
  const def = currentRules.default
  if (typeof def === 'string') return def
  return def[side] ?? 'public'
}

export function resolveFilters(
  rule: ResolvedRule,
  userId: string | undefined,
  claims: Record<string, unknown>
): AppliedFilter[] | null {
  const applied: AppliedFilter[] = []

  for (const f of rule.filters) {
    if (f.authPath === 'auth.id') {
      if (!userId) return null
      applied.push({ field: f.field, value: userId, values: null })
    } else if (f.authPath.startsWith('claims.')) {
      const claimKey = f.authPath.slice(7) // strip "claims."
      const claimValue = getNestedValue(claims, claimKey)
      if (claimValue === undefined || claimValue === null) return null
      if (Array.isArray(claimValue)) {
        const stringValues = claimValue.map(String)
        if (stringValues.length === 0) return null
        applied.push({ field: f.field, value: null, values: stringValues })
      } else {
        applied.push({ field: f.field, value: String(claimValue), values: null })
      }
    }
  }

  return applied
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.')
  let current: unknown = obj
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

// ── API routes (admin-only) ───────────────────────────────────

export const rulesRoutes = new Hono()

function requireAdmin(c: Context): Response | null {
  const role = c.get('role') || 'anonymous'
  if (role === 'admin') return null
  if (role === 'anonymous') return c.json({ error: 'Unauthorized' }, 401) as unknown as Response
  return c.json({ error: 'Forbidden' }, 403) as unknown as Response
}

rulesRoutes.get('/rules', (c) => {
  const denied = requireAdmin(c)
  if (denied) return denied
  return c.json({ rules: getRules(), readonly: isRulesReadonly() })
})

rulesRoutes.put('/rules', async (c) => {
  const denied = requireAdmin(c)
  if (denied) return denied
  if (isRulesReadonly()) return c.json({ error: 'Rules file is read-only (mounted volume)' }, 409)

  const body = await c.req.json()
  if (!validateRules(body)) {
    return c.json({ error: 'Invalid rules format' }, 400)
  }

  writeRules(body)
  return c.json({ rules: getRules(), readonly: false })
})

rulesRoutes.put('/rules/collections/:col', async (c) => {
  const denied = requireAdmin(c)
  if (denied) return denied
  if (isRulesReadonly()) return c.json({ error: 'Rules file is read-only (mounted volume)' }, 409)

  const col = c.req.param('col')
  const body = await c.req.json()

  // Accept string, CollectionRule, or ReadWriteRule
  if (typeof body === 'string') {
    if (!isValidLevel(body)) {
      return c.json({ error: 'Invalid level' }, 400)
    }
  } else if (typeof body === 'object' && body !== null) {
    if (isReadWriteRule(body)) {
      // Validate read/write levels
      if (body.read !== undefined && !validatePermissionLevel(body.read)) {
        return c.json({ error: 'Invalid read permission level' }, 400)
      }
      if (body.write !== undefined && !validatePermissionLevel(body.write)) {
        return c.json({ error: 'Invalid write permission level' }, 400)
      }
    } else {
      // CollectionRule
      if (!validatePermissionLevel(body)) {
        return c.json({ error: 'Invalid access level' }, 400)
      }
    }
  } else {
    return c.json({ error: 'Rule must be a string, { access, filter? }, or { read?, write? }' }, 400)
  }

  const rules = { ...currentRules, collections: { ...currentRules.collections, [col]: body } }
  writeRules(rules as RulesFile)
  return c.json({ rules: getRules(), readonly: false })
})

// ── Legacy permission compat routes ───────────────────────────

function legacyPermRoutes(getDatabase: (c: Context) => string) {
  const app = new Hono()

  app.get('/collections/:collection/permissions', (c) => {
    const denied = requireAdmin(c)
    if (denied) return denied

    const collection = c.req.param('collection')
    const database = getDatabase(c)
    const rule = getRuleForCollection(collection)
    return c.json({ database, collection, level: rule.access })
  })

  app.put('/collections/:collection/permissions', async (c) => {
    const denied = requireAdmin(c)
    if (denied) return denied

    const collection = c.req.param('collection')
    const database = getDatabase(c)
    const body = await c.req.json()

    // Accept { level: string } or { level: string | CollectionRule }
    const level = body.level
    if (typeof level === 'string') {
      if (!isValidLevel(level)) {
        return c.json({ error: 'Invalid level. Must be public, authenticated, admin, owner, or role:<name>' }, 400)
      }
      if (isRulesReadonly()) return c.json({ error: 'Rules file is read-only' }, 409)
      const rules = { ...currentRules, collections: { ...currentRules.collections, [collection]: level } }
      writeRules(rules as RulesFile)
      return c.json({ database, collection, level })
    } else if (typeof level === 'object' && level !== null) {
      // Accept CollectionRule object as level
      if (!level.access || !isValidLevel(level.access)) {
        return c.json({ error: 'Invalid access level' }, 400)
      }
      if (isRulesReadonly()) return c.json({ error: 'Rules file is read-only' }, 409)
      const rules = { ...currentRules, collections: { ...currentRules.collections, [collection]: level } }
      writeRules(rules as RulesFile)
      return c.json({ database, collection, level: level.access })
    }

    return c.json({ error: 'Invalid level' }, 400)
  })

  return app
}

export const legacyPermissionRoutes = legacyPermRoutes(() => 'default')
export const dbLegacyPermissionRoutes = legacyPermRoutes((c) => c.req.param('database')!)
