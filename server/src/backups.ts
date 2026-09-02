import { Hono } from 'hono'
import type { Context, Next } from 'hono'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as zlib from 'node:zlib'
import { once } from 'node:events'
import { Readable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import tar from 'tar-stream'
import { sql, ensureCollection, qualifiedTable, validateDatabaseName, validateCollectionName } from './db.js'
import { publishChange } from './pubsub.js'
import { getRules, isRulesReadonly, writeRules, validateRules, type RulesFile } from './rules.js'
import { getAuthFile, isAuthSettingsReadonly, validateAuthFile, writeAuthFile, type AuthFile } from './auth-settings.js'
import { rebuildAuth } from './auth.js'
import { generateId } from './id.js'

const STORAGE_PATH = process.env.STORAGE_PATH || '/data/files'
const BACKUP_PATH = process.env.BACKUP_PATH || `${STORAGE_PATH}/.backups`
const TMP_PATH = `${BACKUP_PATH}/.tmp`

const BACKUP_FORMAT_VERSION = 1
const BATCH_SIZE = 500

// Auth tables backed up, in FK-safe restore order (accounts reference users)
const AUTH_TABLES = ['user', 'account'] as const

const BACKUP_NAME_RE = /^backup-[A-Za-z0-9][A-Za-z0-9_.-]*\.tar\.gz$/

type BackupType = 'full' | 'documents' | 'auth' | 'storage'

interface BackupManifest {
  version: number
  createdAt: string
  type: BackupType
  scope: { database?: string; collection?: string }
  includes: { documents: boolean; auth: boolean; storage: boolean; rules: boolean }
  stats: {
    databases: Record<string, { collections: Record<string, { docCount: number; sizeBytes: number }> }>
    auth?: { userCount: number }
    storage?: { fileCount: number; totalSizeBytes: number }
  }
}

export interface RestoreOptions {
  /** Restore only these databases' documents */
  databases?: string[]
  /** Restore only these collections — "db/col", or bare "col" for the default db */
  collections?: string[]
  documents?: boolean
  auth?: boolean
  storage?: boolean
  rules?: boolean
  conflict?: 'replace' | 'skip' | 'error'
  /** Same triple format as the query API: [field, op, value] */
  where?: [string, string, unknown][]
  /** Only restore docs whose timeField is before/after this (ms epoch or ISO string) */
  before?: number | string
  after?: number | string
  timeField?: 'created' | 'updated'
}

interface RestoreSummary {
  documents: Record<string, { restored: number; skipped: number; filtered: number }>
  auth: Record<string, { restored: number; skipped: number }>
  storage: { files: number; metadata: number }
  rules: boolean
  warnings: string[]
}

// ── Helpers ───────────────────────────────────────────────────

function ensureDirs() {
  fs.mkdirSync(TMP_PATH, { recursive: true })
}

function backupFilePath(name: string): string | null {
  if (!BACKUP_NAME_RE.test(name) || name.includes('/') || name.includes('..')) return null
  return path.join(BACKUP_PATH, name)
}

function timestampName(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace('.', '')
}

async function requireAdmin(c: Context, next: Next) {
  const role = c.get('role') || 'anonymous'
  if (role !== 'admin') {
    return c.json({ error: role === 'anonymous' ? 'Unauthorized' : 'Forbidden' }, role === 'anonymous' ? 401 : 403)
  }
  return next()
}

async function listCollections(database: string): Promise<string[]> {
  const rows = await sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = ${'db_' + database} AND table_name LIKE 'col_%'
    ORDER BY table_name
  `
  return rows.map((r) => (r.table_name as string).slice(4))
}

async function listDatabases(): Promise<string[]> {
  const rows = await sql`
    SELECT schema_name FROM information_schema.schemata
    WHERE schema_name LIKE 'db_%'
    ORDER BY schema_name
  `
  return rows.map((r) => (r.schema_name as string).slice(3))
}

/** Write to a stream respecting backpressure */
async function write(ws: NodeJS.WritableStream, chunk: string | Buffer) {
  if (!ws.write(chunk)) await once(ws, 'drain')
}

// ── Backup creation ───────────────────────────────────────────

/** Add a tar entry whose size isn't known upfront: spool to a temp file first, then stream it in. */
async function addSpooledEntry(
  pack: tar.Pack,
  name: string,
  produce: (ws: fs.WriteStream) => Promise<void>
) {
  const tmp = path.join(TMP_PATH, `entry-${generateId()}`)
  const ws = fs.createWriteStream(tmp)
  try {
    await produce(ws)
    ws.end()
    await once(ws, 'close')
    await addFileEntry(pack, name, tmp)
  } finally {
    try { fs.unlinkSync(tmp) } catch {}
  }
}

function addFileEntry(pack: tar.Pack, name: string, filePath: string) {
  const size = fs.statSync(filePath).size
  return new Promise<void>((resolve, reject) => {
    const entry = pack.entry({ name, size, mode: 0o644 }, (err) => (err ? reject(err) : resolve()))
    fs.createReadStream(filePath).pipe(entry)
  })
}

function addBufferEntry(pack: tar.Pack, name: string, content: string) {
  return new Promise<void>((resolve, reject) => {
    pack.entry({ name, mode: 0o644 }, content, (err) => (err ? reject(err) : resolve()))
  })
}

async function streamCollectionJsonl(ws: fs.WriteStream, database: string, collection: string) {
  const table = qualifiedTable(database, collection)
  const cursor = sql`SELECT id, data, created_at, updated_at FROM ${table} ORDER BY created_at`.cursor(1000)
  for await (const rows of cursor) {
    for (const row of rows) {
      const line = JSON.stringify({
        id: row.id,
        data: row.data,
        created_at: Number(row.created_at),
        updated_at: Number(row.updated_at),
      })
      await write(ws, line + '\n')
    }
  }
}

async function streamAuthTableJsonl(ws: fs.WriteStream, table: string) {
  const cursor = sql`SELECT * FROM public.${sql(table)}`.cursor(500)
  for await (const rows of cursor) {
    for (const row of rows) {
      await write(ws, JSON.stringify(row) + '\n')
    }
  }
}

export async function createBackup(opts: { type?: BackupType; database?: string; collection?: string }) {
  ensureDirs()

  const type: BackupType = opts.type || 'full'
  const database = opts.collection && !opts.database ? 'default' : opts.database
  const collection = opts.collection

  if (database) {
    const err = validateDatabaseName(database)
    if (err) throw new Error(err)
  }
  if (collection) {
    const err = validateCollectionName(collection)
    if (err) throw new Error(err)
  }
  if ((database || collection) && (type === 'auth' || type === 'storage')) {
    throw new Error(`Cannot scope a "${type}" backup to a database or collection`)
  }

  const scoped = Boolean(database || collection)
  const includes = {
    documents: type === 'full' || type === 'documents',
    auth: type === 'auth' || (type === 'full' && !scoped),
    storage: type === 'storage' || (type === 'full' && !scoped),
    rules: type === 'full' && !scoped,
  }

  // ── Gather stats + build manifest ───────────────────────────
  const stats: BackupManifest['stats'] = { databases: {} }

  if (includes.documents) {
    const dbs = database ? [database] : await listDatabases()
    for (const db of dbs) {
      const cols = collection ? [collection] : await listCollections(db)
      const colStats: Record<string, { docCount: number; sizeBytes: number }> = {}
      for (const col of cols) {
        const table = qualifiedTable(db, col)
        try {
          const rows = await sql`
            SELECT COUNT(*)::int AS count, COALESCE(SUM(pg_column_size(data)), 0)::bigint AS size
            FROM ${table}
          `
          colStats[col] = { docCount: rows[0].count, sizeBytes: Number(rows[0].size) }
        } catch {
          // Collection doesn't exist (scoped backup of unknown collection)
        }
      }
      if (Object.keys(colStats).length > 0) stats.databases[db] = { collections: colStats }
    }
  }

  if (includes.auth) {
    const rows = await sql`SELECT COUNT(*)::int AS count FROM public.${sql('user')}`
    stats.auth = { userCount: rows[0].count }
  }

  if (includes.storage) {
    const rows = await sql`
      SELECT COUNT(*)::int AS count, COALESCE(SUM(size), 0)::bigint AS total FROM _ezbase_files
    `
    stats.storage = { fileCount: rows[0].count, totalSizeBytes: Number(rows[0].total) }
  }

  const manifest: BackupManifest = {
    version: BACKUP_FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    type,
    scope: { ...(database ? { database } : {}), ...(collection ? { collection } : {}) },
    includes,
    stats,
  }

  const name =
    `backup-${timestampName()}` +
    (database ? `-${database}` : '') +
    (collection ? `-${collection}` : '') +
    (type !== 'full' ? `-${type}` : '') +
    '.tar.gz'
  const finalPath = path.join(BACKUP_PATH, name)
  const partialPath = path.join(TMP_PATH, name + '.partial')

  // ── Stream the archive ──────────────────────────────────────
  const pack = tar.pack()
  const gzip = zlib.createGzip()
  const out = fs.createWriteStream(partialPath)
  const done = new Promise<void>((resolve, reject) => {
    out.on('close', () => resolve())
    out.on('error', reject)
    pack.on('error', reject)
    gzip.on('error', reject)
  })
  pack.pipe(gzip).pipe(out)

  try {
    await addBufferEntry(pack, 'manifest.json', JSON.stringify(manifest, null, 2) + '\n')

    if (includes.rules) {
      await addBufferEntry(pack, 'rules.json', JSON.stringify(getRules(), null, 2) + '\n')
      await addBufferEntry(pack, 'auth.json', JSON.stringify(getAuthFile(), null, 2) + '\n')
    }

    if (includes.documents) {
      for (const [db, dbStats] of Object.entries(stats.databases)) {
        for (const col of Object.keys(dbStats.collections)) {
          await addSpooledEntry(pack, `databases/${db}/${col}.jsonl`, (ws) =>
            streamCollectionJsonl(ws, db, col)
          )
        }
      }
    }

    if (includes.auth) {
      for (const table of AUTH_TABLES) {
        await addSpooledEntry(pack, `auth/${table}s.jsonl`, (ws) => streamAuthTableJsonl(ws, table))
      }
    }

    if (includes.storage) {
      await addSpooledEntry(pack, 'storage-meta.jsonl', async (ws) => {
        const cursor = sql`SELECT * FROM _ezbase_files`.cursor(500)
        for await (const rows of cursor) {
          for (const row of rows) {
            await write(ws, JSON.stringify({
              path: row.path,
              bucket: row.bucket,
              filename: row.filename,
              size: Number(row.size),
              mime_type: row.mime_type,
              uploaded_by: row.uploaded_by,
              created_at: Number(row.created_at),
              updated_at: Number(row.updated_at),
            }) + '\n')
          }
        }
      })

      const cursor = sql`SELECT path FROM _ezbase_files`.cursor(500)
      for await (const rows of cursor) {
        for (const row of rows) {
          const diskPath = path.join(STORAGE_PATH, row.path as string)
          if (fs.existsSync(diskPath)) {
            await addFileEntry(pack, `storage/${row.path}`, diskPath)
          }
        }
      }
    }

    pack.finalize()
    await done
    fs.renameSync(partialPath, finalPath)
  } catch (err) {
    pack.destroy()
    try { fs.unlinkSync(partialPath) } catch {}
    throw err
  }

  return { name, size: fs.statSync(finalPath).size, manifest }
}

// ── Backup inspection ─────────────────────────────────────────

/** Read manifest.json (always the first entry) without decompressing the whole archive. */
function readManifest(filePath: string): Promise<BackupManifest | null> {
  return new Promise((resolve) => {
    const rs = fs.createReadStream(filePath)
    const gunzip = zlib.createGunzip()
    const extract = tar.extract()
    let settled = false
    const finish = (value: BackupManifest | null) => {
      if (settled) return
      settled = true
      resolve(value)
      rs.destroy()
    }

    extract.on('entry', (header, stream, next) => {
      if (header.name === 'manifest.json') {
        const chunks: Buffer[] = []
        stream.on('data', (c) => chunks.push(c))
        stream.on('end', () => {
          try {
            finish(JSON.parse(Buffer.concat(chunks).toString('utf8')))
          } catch {
            finish(null)
          }
        })
      } else {
        stream.resume()
        stream.on('end', next)
      }
    })
    extract.on('finish', () => finish(null))
    extract.on('error', () => finish(null))
    gunzip.on('error', () => finish(null))
    rs.on('error', () => finish(null))
    rs.pipe(gunzip).pipe(extract)
  })
}

async function listBackups() {
  ensureDirs()
  const names = fs.readdirSync(BACKUP_PATH).filter((n) => BACKUP_NAME_RE.test(n))
  const backups = await Promise.all(
    names.map(async (name) => {
      const st = fs.statSync(path.join(BACKUP_PATH, name))
      const manifest = await readManifest(path.join(BACKUP_PATH, name))
      return { name, size: st.size, createdAt: manifest?.createdAt ?? st.mtime.toISOString(), manifest }
    })
  )
  backups.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  return backups
}

function resolveLatest(): string | null {
  ensureDirs()
  const names = fs.readdirSync(BACKUP_PATH).filter((n) => BACKUP_NAME_RE.test(n))
  if (names.length === 0) return null
  names.sort((a, b) => fs.statSync(path.join(BACKUP_PATH, b)).mtimeMs - fs.statSync(path.join(BACKUP_PATH, a)).mtimeMs)
  return names[0]
}

// ── Restore ───────────────────────────────────────────────────

function parseTime(value: number | string | undefined): number | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'number') return value
  const n = Number(value)
  if (!Number.isNaN(n) && value.trim() !== '') return n
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) throw new Error(`Invalid timestamp: ${value}`)
  return parsed
}

function compare(a: unknown, op: string, b: unknown): boolean {
  switch (op) {
    case '==': return a === b || String(a) === String(b)
    case '!=': return !(a === b || String(a) === String(b))
  }
  const an = typeof a === 'number' ? a : Number(a)
  const bn = typeof b === 'number' ? b : Number(b)
  const numeric = !Number.isNaN(an) && !Number.isNaN(bn)
  const [x, y] = numeric ? [an, bn] : [String(a), String(b)]
  switch (op) {
    case '<': return x < y
    case '>': return x > y
    case '<=': return x <= y
    case '>=': return x >= y
    default: throw new Error(`Invalid operator: ${op}`)
  }
}

interface DocFilter {
  where: [string, string, unknown][]
  before?: number
  after?: number
  timeField: 'created' | 'updated'
}

function docPasses(doc: { data: Record<string, unknown>; created_at: number; updated_at: number }, f: DocFilter): boolean {
  const ts = f.timeField === 'created' ? doc.created_at : doc.updated_at
  if (f.before !== undefined && ts >= f.before) return false
  if (f.after !== undefined && ts <= f.after) return false
  for (const [field, op, value] of f.where) {
    const actual =
      field === 'created' ? doc.created_at :
      field === 'updated' ? doc.updated_at :
      doc.data?.[field]
    if (!compare(actual, op, value)) return false
  }
  return true
}

/** Async iterator over UTF-8 lines of a stream (handles multi-byte chars split across chunks) */
async function* lines(stream: NodeJS.ReadableStream): AsyncGenerator<string> {
  const decoder = new StringDecoder('utf8')
  let buf = ''
  for await (const chunk of stream) {
    buf += decoder.write(chunk as Buffer)
    let idx
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      if (line.trim()) yield line
    }
  }
  buf += decoder.end()
  if (buf.trim()) yield buf
}

type Conflict = 'replace' | 'skip' | 'error'

const CONFLICT_CLAUSE: Record<Conflict, string> = {
  replace: 'ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at',
  skip: 'ON CONFLICT (id) DO NOTHING',
  error: '',
}

async function insertDocBatch(
  trx: any,
  database: string,
  collection: string,
  batch: { id: string; data: unknown; created_at: number; updated_at: number }[],
  conflict: Conflict
): Promise<number> {
  if (batch.length === 0) return 0
  const params: unknown[] = []
  const values = batch
    .map((d) => {
      // Pass data raw: the ::jsonb cast makes PG type the param as jsonb, and
      // postgres.js JSON-serializes the value itself — pre-stringifying double-encodes.
      params.push(d.id, d.data, d.created_at, d.updated_at)
      const n = params.length
      return `($${n - 3}, $${n - 2}::jsonb, $${n - 1}, $${n})`
    })
    .join(', ')
  const query =
    `INSERT INTO db_${database}.col_${collection} (id, data, created_at, updated_at) ` +
    `VALUES ${values} ${CONFLICT_CLAUSE[conflict]} RETURNING id`
  const rows = await trx.unsafe(query, params as any[])
  return rows.length
}

function normalizeCollectionTarget(target: string): { database: string; collection: string } {
  const parts = target.split('/')
  if (parts.length === 1) return { database: 'default', collection: parts[0] }
  return { database: parts[0], collection: parts.slice(1).join('/') }
}

const STORAGE_ENTRY_RE = /^[a-zA-Z0-9][a-zA-Z0-9_\-./]*$/

function sanitizeStoragePath(p: string): string | null {
  if (!STORAGE_ENTRY_RE.test(p)) return null
  if (p.includes('..') || p.endsWith('/')) return null
  return p.replace(/\/+/g, '/')
}

export async function restoreFromStream(source: NodeJS.ReadableStream, opts: RestoreOptions): Promise<RestoreSummary> {
  const conflict: Conflict = opts.conflict || 'replace'
  if (!['replace', 'skip', 'error'].includes(conflict)) throw new Error(`Invalid conflict mode: ${conflict}`)

  const anySelector = Boolean(
    opts.documents || opts.auth || opts.storage || opts.rules ||
    opts.databases?.length || opts.collections?.length
  )
  const includeDocs = anySelector ? Boolean(opts.documents || opts.databases?.length || opts.collections?.length) : true
  const includeAuth = anySelector ? Boolean(opts.auth) : true
  const includeStorage = anySelector ? Boolean(opts.storage) : true
  const includeRules = anySelector ? Boolean(opts.rules) : true

  const collectionTargets = (opts.collections || []).map(normalizeCollectionTarget)
  const databaseTargets = opts.databases || []

  function collectionSelected(database: string, collection: string): boolean {
    if (!includeDocs) return false
    if (databaseTargets.length === 0 && collectionTargets.length === 0) return true
    if (databaseTargets.includes(database)) return true
    return collectionTargets.some((t) => t.database === database && t.collection === collection)
  }

  const filter: DocFilter = {
    where: opts.where || [],
    before: parseTime(opts.before),
    after: parseTime(opts.after),
    timeField: opts.timeField === 'created' ? 'created' : 'updated',
  }
  for (const w of filter.where) {
    if (!Array.isArray(w) || w.length !== 3 || typeof w[0] !== 'string') throw new Error('Invalid where clause')
    compare(0, w[1], 0) // throws on invalid operator
  }

  const summary: RestoreSummary = {
    documents: {},
    auth: {},
    storage: { files: 0, metadata: 0 },
    rules: false,
    warnings: [],
  }

  async function restoreCollectionEntry(database: string, collection: string, stream: NodeJS.ReadableStream) {
    if (validateDatabaseName(database) || validateCollectionName(collection)) {
      summary.warnings.push(`Skipped invalid collection path in archive: ${database}/${collection}`)
      stream.resume()
      return
    }
    await ensureCollection(database, collection)
    const key = `${database}/${collection}`
    const counts = { restored: 0, skipped: 0, filtered: 0 }
    summary.documents[key] = counts

    await sql.begin(async (trx) => {
      let batch: { id: string; data: unknown; created_at: number; updated_at: number }[] = []
      const flush = async () => {
        const inserted = await insertDocBatch(trx, database, collection, batch, conflict)
        counts.restored += inserted
        counts.skipped += batch.length - inserted
        batch = []
      }
      for await (const line of lines(stream)) {
        let doc
        try {
          doc = JSON.parse(line)
        } catch {
          summary.warnings.push(`Malformed JSONL line in ${key}, skipped`)
          continue
        }
        if (!doc || typeof doc.id !== 'string') {
          summary.warnings.push(`Doc without id in ${key}, skipped`)
          continue
        }
        doc.created_at = Number(doc.created_at)
        doc.updated_at = Number(doc.updated_at)
        if (!docPasses(doc, filter)) {
          counts.filtered++
          continue
        }
        batch.push(doc)
        if (batch.length >= BATCH_SIZE) await flush()
      }
      await flush()
    })

    await publishChange({ type: 'modified', id: '*', collection, database })
  }

  async function restoreAuthEntry(table: string, stream: NodeJS.ReadableStream) {
    const counts = { restored: 0, skipped: 0 }
    summary.auth[table] = counts
    await sql.begin(async (trx) => {
      // postgres.js's TransactionSql type drops Sql's call signatures via Omit,
      // even though transactions expose the same tagged-template API at runtime.
      const tx = trx as unknown as typeof sql
      for await (const line of lines(stream)) {
        let row: Record<string, unknown>
        try {
          row = JSON.parse(line)
        } catch {
          summary.warnings.push(`Malformed JSONL line in auth/${table}s, skipped`)
          continue
        }
        if (!row || typeof row.id !== 'string') continue
        const cols = Object.keys(row).filter((k) => k !== 'id')
        let inserted
        if (conflict === 'replace') {
          inserted = await tx`
            INSERT INTO public.${tx(table)} ${tx(row)}
            ON CONFLICT (id) DO UPDATE SET ${tx(row as any, ...cols as any)}
            RETURNING id
          `
        } else if (conflict === 'skip') {
          inserted = await tx`
            INSERT INTO public.${tx(table)} ${tx(row)}
            ON CONFLICT (id) DO NOTHING
            RETURNING id
          `
        } else {
          inserted = await tx`INSERT INTO public.${tx(table)} ${tx(row)} RETURNING id`
        }
        counts.restored += inserted.length
        counts.skipped += 1 - inserted.length
      }
    })
  }

  async function restoreStorageMeta(stream: NodeJS.ReadableStream) {
    for await (const line of lines(stream)) {
      let row
      try {
        row = JSON.parse(line)
      } catch {
        summary.warnings.push('Malformed storage-meta.jsonl line, skipped')
        continue
      }
      if (!row || typeof row.path !== 'string') continue
      const clean = sanitizeStoragePath(row.path)
      if (!clean) continue
      await sql`
        INSERT INTO _ezbase_files (path, bucket, filename, size, mime_type, uploaded_by, created_at, updated_at)
        VALUES (${clean}, ${row.bucket}, ${row.filename}, ${row.size}, ${row.mime_type}, ${row.uploaded_by ?? null}, ${row.created_at}, ${row.updated_at})
        ON CONFLICT (path) DO UPDATE SET
          bucket = EXCLUDED.bucket, filename = EXCLUDED.filename, size = EXCLUDED.size,
          mime_type = EXCLUDED.mime_type, uploaded_by = EXCLUDED.uploaded_by, updated_at = EXCLUDED.updated_at
      `
      summary.storage.metadata++
    }
  }

  async function restoreStorageFile(relPath: string, stream: NodeJS.ReadableStream) {
    const clean = sanitizeStoragePath(relPath)
    if (!clean) {
      summary.warnings.push(`Skipped invalid storage path in archive: ${relPath}`)
      stream.resume()
      return
    }
    const diskPath = path.join(STORAGE_PATH, clean)
    fs.mkdirSync(path.dirname(diskPath), { recursive: true })
    const ws = fs.createWriteStream(diskPath)
    stream.pipe(ws)
    await once(ws, 'close')
    summary.storage.files++
  }

  async function handleEntry(header: tar.Headers, stream: NodeJS.ReadableStream) {
    const name = header.name.replace(/^\.\//, '')

    if (header.type !== 'file') {
      stream.resume()
      return
    }

    if (name === 'manifest.json') {
      stream.resume() // format version checks can hook in here later
      return
    }

    if (name === 'auth.json') {
      if (!includeRules) return stream.resume()
      const chunks: Buffer[] = []
      for await (const c of stream) chunks.push(c as Buffer)
      if (isAuthSettingsReadonly()) {
        summary.warnings.push('auth.json is read-only on this instance — auth settings not restored')
        return
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (!validateAuthFile(parsed)) throw new Error('invalid')
        writeAuthFile(parsed as AuthFile)
        rebuildAuth()
      } catch {
        summary.warnings.push('Invalid auth.json in backup — auth settings not restored')
      }
      return
    }

    if (name === 'rules.json') {
      if (!includeRules) return stream.resume()
      const chunks: Buffer[] = []
      for await (const c of stream) chunks.push(c as Buffer)
      if (isRulesReadonly()) {
        summary.warnings.push('rules.json is read-only on this instance — rules not restored')
        return
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (!validateRules(parsed)) throw new Error('invalid')
        writeRules(parsed as RulesFile)
        summary.rules = true
      } catch {
        summary.warnings.push('Invalid rules.json in backup — rules not restored')
      }
      return
    }

    const docMatch = name.match(/^databases\/([^/]+)\/(.+)\.jsonl$/)
    if (docMatch) {
      const [, database, collection] = docMatch
      if (!collectionSelected(database, collection)) return stream.resume()
      await restoreCollectionEntry(database, collection, stream)
      return
    }

    const authMatch = name.match(/^auth\/(.+)s\.jsonl$/)
    if (authMatch && (AUTH_TABLES as readonly string[]).includes(authMatch[1])) {
      if (!includeAuth) return stream.resume()
      await restoreAuthEntry(authMatch[1], stream)
      return
    }

    if (name === 'storage-meta.jsonl') {
      if (!includeStorage) return stream.resume()
      await restoreStorageMeta(stream)
      return
    }

    if (name.startsWith('storage/')) {
      if (!includeStorage) return stream.resume()
      await restoreStorageFile(name.slice('storage/'.length), stream)
      return
    }

    summary.warnings.push(`Unknown entry in archive, skipped: ${name}`)
    stream.resume()
  }

  const gunzip = zlib.createGunzip()
  const extract = tar.extract()

  await new Promise<void>((resolve, reject) => {
    extract.on('entry', (header, stream, next) => {
      handleEntry(header, stream)
        .then(() => next())
        .catch((err) => {
          stream.resume()
          reject(err)
        })
    })
    extract.on('finish', () => resolve())
    extract.on('error', reject)
    gunzip.on('error', (err) => reject(new Error(`Not a valid gzip archive: ${err.message}`)))
    source.on('error', reject)
    source.pipe(gunzip).pipe(extract)
  })

  return summary
}

// ── Routes (all admin-only) ───────────────────────────────────

const backupRoutes = new Hono()

backupRoutes.use('/backups', requireAdmin)
backupRoutes.use('/backups/*', requireAdmin)
backupRoutes.use('/restore', requireAdmin)

// Create backup
backupRoutes.post('/backups', async (c) => {
  let body: { type?: BackupType; database?: string; collection?: string } = {}
  try {
    const raw = await c.req.text()
    if (raw) body = JSON.parse(raw)
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }
  if (body.type && !['full', 'documents', 'auth', 'storage'].includes(body.type)) {
    return c.json({ error: `Invalid backup type: ${body.type}` }, 400)
  }
  try {
    const result = await createBackup(body)
    return c.json(result, 201)
  } catch (err: any) {
    return c.json({ error: err.message }, 400)
  }
})

// List backups
backupRoutes.get('/backups', async (c) => {
  return c.json(await listBackups())
})

// Download backup ("latest" resolves to the newest)
backupRoutes.get('/backups/:name', async (c) => {
  let name = c.req.param('name')
  if (name === 'latest') {
    const latest = resolveLatest()
    if (!latest) return c.json({ error: 'No backups found' }, 404)
    name = latest
  }
  const filePath = backupFilePath(name)
  if (!filePath) return c.json({ error: 'Invalid backup name' }, 400)
  const file = Bun.file(filePath)
  if (!(await file.exists())) return c.json({ error: 'Backup not found' }, 404)

  c.header('Content-Type', 'application/gzip')
  c.header('Content-Length', String(file.size))
  c.header('Content-Disposition', `attachment; filename="${name}"`)
  c.header('X-Backup-Name', name)
  return c.body(file.stream())
})

// Delete backup
backupRoutes.delete('/backups/:name', async (c) => {
  const filePath = backupFilePath(c.req.param('name'))
  if (!filePath) return c.json({ error: 'Invalid backup name' }, 400)
  if (!fs.existsSync(filePath)) return c.json({ error: 'Backup not found' }, 404)
  fs.unlinkSync(filePath)
  return c.json({ success: true })
})

// Restore from a server-side backup
backupRoutes.post('/backups/:name/restore', async (c) => {
  let name = c.req.param('name')
  if (name === 'latest') {
    const latest = resolveLatest()
    if (!latest) return c.json({ error: 'No backups found' }, 404)
    name = latest
  }
  const filePath = backupFilePath(name)
  if (!filePath) return c.json({ error: 'Invalid backup name' }, 400)
  if (!fs.existsSync(filePath)) return c.json({ error: 'Backup not found' }, 404)

  let opts: RestoreOptions = {}
  try {
    const raw = await c.req.text()
    if (raw) opts = JSON.parse(raw)
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  try {
    const summary = await restoreFromStream(fs.createReadStream(filePath), opts)
    return c.json({ backup: name, ...summary })
  } catch (err: any) {
    return c.json({ error: `Restore failed: ${err.message}` }, 409)
  }
})

// Restore from an uploaded archive (raw tar.gz body; options via ?options=<json>)
backupRoutes.post('/restore', async (c) => {
  let opts: RestoreOptions = {}
  const optsParam = c.req.query('options')
  if (optsParam) {
    try {
      opts = JSON.parse(optsParam)
    } catch {
      return c.json({ error: 'Invalid options JSON' }, 400)
    }
  }

  const body = c.req.raw.body
  if (!body) return c.json({ error: 'No backup file in request body' }, 400)

  try {
    const summary = await restoreFromStream(Readable.fromWeb(body as any), opts)
    return c.json(summary)
  } catch (err: any) {
    return c.json({ error: `Restore failed: ${err.message}` }, 409)
  }
})

export { backupRoutes }
