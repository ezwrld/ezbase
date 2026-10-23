import fs from 'node:fs'
import { spawn, type Subprocess } from 'bun'

/**
 * Every ezbase instance this machine can see: local containers found through the
 * Docker socket, plus remote instances listed in ~/.ezbase/fleet.json.
 */

const HOME = process.env.FLEET_HOME || process.env.HOME || ''
export const CONFIG_PATH = `${HOME}/.ezbase/fleet.json`
const DOCKER_SOCKET = '/var/run/docker.sock'
const DOCKER_HOST = 'host.docker.internal'
const POLL_MS = 30_000
const STATS_MS = 60 * 60_000
const TIMEOUT_MS = 8_000
const SPARK_BUCKETS = 48

type Secret = string | { file: string; var: string }

type RemoteConfig = {
  name: string
  env: string
  url?: string
  key?: Secret
  ssh?: { host: Secret; password?: Secret; port?: number }
}

export type Env = 'prod' | 'dev' | 'local'
export type State = 'up' | 'down' | 'stopped'

export type Instance = {
  id: string
  name: string
  env: Env
  host: string
  base: string | null
  key: string | null
  state: State
  version: string | null
  error: string | null
  requests: number | null
  errors: number | null
  avgMs: number | null
  spark: number[]
  docs: number | null
  bytes: number | null
  collections: number | null
  lastBackup: string | null
  backups: number | null
  indexes: Record<string, number> | null
  checkedAt: number
  statsAt: number
}

const instances = new Map<string, Instance>()
const tunnels = new Map<string, { proc: Subprocess; port: number }>()
let latest: string | null = null
let nextTunnelPort = 17100

export function fleet() {
  return { latest, instances: [...instances.values()].map(publicView) }
}

export function instance(id: string) {
  return instances.get(id) ?? null
}

function publicView(i: Instance) {
  const { key, base, ...rest } = i
  return { ...rest, keyed: Boolean(key) }
}

// ── Secrets ────────────────────────────────────────────────────

function readSecret(secret: Secret | undefined): string | null {
  if (!secret) return null
  if (typeof secret === 'string') return secret
  try {
    const text = fs.readFileSync(secret.file.replace(/^~/, HOME), 'utf-8')
    const line = text.split('\n').find((l) => l.replace(/^export\s+/, '').startsWith(`${secret.var}=`))
    if (!line) return null
    return line.slice(line.indexOf('=') + 1).trim().replace(/^(['"])(.*)\1$/, '$2') || null
  } catch {
    return null
  }
}

// ── Discovery ──────────────────────────────────────────────────

type Container = {
  Names: string[]
  Image: string
  State: string
  Ports: { IP?: string; PrivatePort: number; PublicPort?: number }[]
  Labels: Record<string, string>
  Id: string
}

async function docker<T>(path: string): Promise<T> {
  const res = await fetch(`http://docker${path}`, { unix: DOCKER_SOCKET } as RequestInit)
  if (!res.ok) throw new Error(`docker ${path}: ${res.status}`)
  return res.json() as Promise<T>
}

function imageVersion(image: string) {
  const tag = image.split('@')[0].split(':')[1]
  return tag && /^\d+\.\d+/.test(tag) ? tag : null
}

async function discoverLocal(): Promise<Instance[]> {
  const containers = await docker<Container[]>('/containers/json?all=1')
  const found: Instance[] = []
  for (const c of containers) {
    if (!c.Image.startsWith('ghcr.io/ezwrld/ezbase')) continue
    const project = c.Labels['com.docker.compose.project'] || c.Names[0].replace(/^\//, '')
    const port = c.Ports.find((p) => p.PrivatePort === 7003 && p.PublicPort)?.PublicPort
    const inspect = await docker<{ Config: { Env: string[] } }>(`/containers/${c.Id}/json`)
    const env = Object.fromEntries(inspect.Config.Env.map((e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]))
    let path = ''
    try {
      path = env.EZBASE_URL ? new URL(env.EZBASE_URL).pathname.replace(/\/$/, '') : ''
    } catch {}
    const running = c.State === 'running' && port
    found.push(
      blank({
        id: slug(project),
        name: project,
        env: 'local',
        host: port ? `localhost:${port}${path}` : '',
        base: running ? `http://${DOCKER_HOST}:${port}${path}` : null,
        key: env.ADMIN_KEY || null,
        state: running ? 'down' : 'stopped',
        version: imageVersion(c.Image),
      }),
    )
  }
  return found
}

function readConfig(): RemoteConfig[] {
  try {
    return (JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')).instances || []) as RemoteConfig[]
  } catch {
    return []
  }
}

async function remoteInstances(): Promise<Instance[]> {
  const out: Instance[] = []
  for (const r of readConfig()) {
    const id = slug(`${r.name}-${r.env}`)
    let base = r.url?.replace(/\/$/, '') || null
    let host = r.url ? r.url.replace(/^https?:\/\//, '').replace(/\/$/, '') : ''
    if (r.ssh) {
      const target = readSecret(r.ssh.host)
      host = target ? `ssh ${target.replace(/^.*@/, '')}` : 'ssh'
      base = target ? await tunnel(id, target, readSecret(r.ssh.password), r.ssh.port || 7003) : null
    }
    out.push(
      blank({
        id,
        name: r.name,
        env: r.env === 'prod' || r.env === 'dev' ? r.env : 'dev',
        host,
        base,
        key: readSecret(r.key),
        state: 'down',
        version: null,
      }),
    )
  }
  return out
}

function blank(i: Pick<Instance, 'id' | 'name' | 'env' | 'host' | 'base' | 'key' | 'state' | 'version'>): Instance {
  return {
    ...i,
    error: null,
    requests: null,
    errors: null,
    avgMs: null,
    spark: [],
    docs: null,
    bytes: null,
    collections: null,
    lastBackup: null,
    backups: null,
    indexes: null,
    checkedAt: 0,
    statsAt: 0,
  }
}

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

// ── SSH tunnels ────────────────────────────────────────────────

async function tunnel(id: string, target: string, password: string | null, remotePort: number) {
  const existing = tunnels.get(id)
  if (existing && existing.proc.exitCode === null) return `http://127.0.0.1:${existing.port}`
  const port = existing?.port ?? nextTunnelPort++
  const ssh = [
    'ssh', '-N',
    '-L', `127.0.0.1:${port}:127.0.0.1:${remotePort}`,
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'StrictHostKeyChecking=accept-new',
    target,
  ]
  const proc = spawn(password ? ['sshpass', '-e', ...ssh] : ssh, {
    env: { ...process.env, SSHPASS: password || '' },
    stdout: 'ignore',
    stderr: 'ignore',
  })
  tunnels.set(id, { proc, port })
  for (let i = 0; i < 40; i++) {
    if (proc.exitCode !== null) break
    try {
      await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) })
      break
    } catch {
      await Bun.sleep(250)
    }
  }
  return `http://127.0.0.1:${port}`
}

// ── Polling ────────────────────────────────────────────────────

export async function api<T>(i: Instance, path: string): Promise<T> {
  const res = await fetch(`${i.base}/api${path}`, {
    headers: i.key ? { Authorization: `Bearer ${i.key}` } : {},
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`${path} ${res.status}`)
  return res.json() as Promise<T>
}

type Point = { ts: number; requests: number; errors: number; avgMs: number }

async function check(i: Instance, prev: Instance | undefined) {
  if (prev) {
    for (const k of ['docs', 'bytes', 'collections', 'lastBackup', 'backups', 'indexes', 'statsAt'] as const) (i as Record<string, unknown>)[k] = prev[k]
  }
  if (!i.base) return
  try {
    const health = await api<{ version?: string }>(i, '/health')
    i.state = 'up'
    i.version = health.version ?? i.version
  } catch (e) {
    i.state = 'down'
    i.error = e instanceof Error ? e.message : String(e)
    return
  }
  if (!i.key) return

  // /health and /analytics are not recorded in an instance's own analytics; everything else waits for the hourly pass.
  const [summary, series] = await Promise.allSettled([
    api<{ requests: number; errors: number; avgMs: number }>(i, '/analytics/summary?hours=24'),
    api<Point[]>(i, '/analytics/timeseries?minutes=1440'),
  ])
  if (summary.status === 'fulfilled') {
    i.requests = summary.value.requests
    i.errors = summary.value.errors
    i.avgMs = summary.value.avgMs
  } else {
    i.error = String(summary.reason?.message ?? summary.reason)
  }
  if (series.status === 'fulfilled') i.spark = bucket(series.value, 1440, SPARK_BUCKETS).map((b) => b.requests)
  if (Date.now() - i.statsAt > STATS_MS) await collectStats(i)
}

/** Per-minute points → `count` equal buckets over the last `minutes`. Metrics only record minutes with traffic, so an empty bucket is zero requests. */
export function bucket(points: Point[], minutes: number, count: number) {
  const end = Math.floor(Date.now() / 60000) * 60000 + 60000
  const start = end - minutes * 60000
  const width = (minutes * 60000) / count
  const out = Array.from({ length: count }, (_, n) => ({
    ts: start + n * width,
    requests: 0,
    errors: 0,
    totalMs: 0,
  }))
  for (const p of points) {
    const n = Math.floor((p.ts - start) / width)
    if (n < 0 || n >= count) continue
    const b = out[n]
    b.requests += p.requests
    b.errors += p.errors
    b.totalMs += p.avgMs * p.requests
  }
  return out.map((b) => ({
    ts: b.ts,
    requests: b.requests,
    errors: b.errors,
    avgMs: b.requests ? Math.round(b.totalMs / b.requests) : null,
  }))
}

export type CollectionStat = { database: string; name: string; count: number; size: number }

export async function collectionStats(i: Instance): Promise<CollectionStat[]> {
  const databases = await api<string[]>(i, '/databases')
  const out: CollectionStat[] = []
  for (const database of databases) {
    const prefix = database === 'default' ? '' : `/db/${encodeURIComponent(database)}`
    const names = await api<string[]>(i, `${prefix}/collections`)
    for (const name of names) {
      const s = await api<{ count: number; size: number }>(i, `${prefix}/collections/${encodeURIComponent(name)}/stats`)
      out.push({ database, name, count: s.count, size: s.size })
    }
  }
  return out
}

export type Slow = {
  collections: CollectionStat[]
  backups: { name: string; size: number; createdAt: string }[]
  indexes: { state: string }[]
}

const slowCache = new Map<string, Slow>()

export function cached(id: string): Slow {
  return slowCache.get(id) ?? { collections: [], backups: [], indexes: [] }
}

async function collectStats(i: Instance) {
  const [backups, indexes] = await Promise.allSettled([
    api<Slow['backups']>(i, '/backups'),
    api<Slow['indexes']>(i, '/indexes'),
  ])
  const slow = cached(i.id)
  if (backups.status === 'fulfilled') {
    slow.backups = backups.value.slice(0, 5).map(({ name, size, createdAt }) => ({ name, size, createdAt }))
    i.backups = backups.value.length
    i.lastBackup = backups.value[0]?.createdAt ?? null
  }
  if (indexes.status === 'fulfilled') {
    slow.indexes = indexes.value
    i.indexes = {}
    for (const x of indexes.value) i.indexes[x.state] = (i.indexes[x.state] || 0) + 1
  }
  try {
    const stats = await collectionStats(i)
    slow.collections = stats
    i.docs = stats.reduce((n, s) => n + s.count, 0)
    i.bytes = stats.reduce((n, s) => n + s.size, 0)
    i.collections = stats.length
    i.statsAt = Date.now()
  } catch {}
  slowCache.set(i.id, slow)
}

async function refreshLatest() {
  try {
    const res = await fetch('https://api.github.com/repos/ezwrld/ezbase/releases/latest', { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (res.ok) latest = ((await res.json()) as { tag_name: string }).tag_name.replace(/^v/, '')
  } catch {}
}

async function poll() {
  let found: Instance[] = []
  try {
    found = [...(await discoverLocal()), ...(await remoteInstances())]
  } catch (e) {
    console.error('fleet: discovery failed', e)
    return
  }
  await Promise.all(found.map((i) => check(i, instances.get(i.id)).finally(() => (i.checkedAt = Date.now()))))
  instances.clear()
  for (const i of found) instances.set(i.id, i)
}

export function start() {
  refreshLatest()
  setInterval(refreshLatest, 60 * 60_000)
  const loop = () => poll().finally(() => setTimeout(loop, POLL_MS))
  loop()
}
