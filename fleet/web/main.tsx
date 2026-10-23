import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'

type Env = 'prod' | 'dev' | 'local'
type State = 'up' | 'down' | 'stopped'

type Instance = {
  id: string
  name: string
  env: Env
  host: string
  state: State
  version: string | null
  error: string | null
  requests: number | null
  errors: number | null
  avgMs: number | null
  spark: (number | null)[]
  docs: number | null
  bytes: number | null
  collections: number | null
  lastBackup: string | null
  backups: number | null
  indexes: Record<string, number> | null
  keyed: boolean
  checkedAt: number
}

type Point = { ts: number; requests: number | null; errors: number | null; avgMs: number | null }
type Detail = {
  instance: Instance
  series: Point[]
  top: { database: string; collection: string; requests: number; errors: number; avgMs: number }[]
  collections: { database: string; name: string; count: number; size: number }[]
  indexes: { database: string; collection: string; name: string; equals?: string[]; orderedBy?: string; state: string; sizeBytes: number; reads: number }[]
  backups: { name: string; size: number; createdAt: string }[]
}

const POLL_MS = 15_000
const ENV_ORDER: Record<Env, number> = { prod: 0, dev: 1, local: 2 }
const STATE_ORDER: Record<State, number> = { down: 0, up: 1, stopped: 2 }

// ── Formatting ────────────────────────────────────────────────

function compact(n: number) {
  if (n >= 1e9) return `${trim(n / 1e9)}B`
  if (n >= 1e6) return `${trim(n / 1e6)}M`
  if (n >= 1e3) return `${trim(n / 1e3)}k`
  return String(Math.round(n))
}

function trim(n: number) {
  return n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1).replace(/\.0$/, '') : n.toFixed(2).replace(/\.?0+$/, '')
}

function bytes(n: number) {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(n >= 100 * 1024 ** 2 ? 0 : 1)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} B`
}

function age(iso: string | null) {
  if (!iso) return null
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}

const STALE_BACKUP_MS = 7 * 86_400_000

function staleBackup(iso: string | null) {
  return !iso || Date.now() - new Date(iso).getTime() > STALE_BACKUP_MS
}

function rate(requests: number | null) {
  if (requests === null) return null
  const perMin = requests / 1440
  return perMin >= 1 ? `${compact(perMin)}/min` : `${compact(requests)}/day`
}

function errorPct(i: Instance) {
  if (i.requests === null || i.errors === null || i.requests === 0) return null
  return (i.errors / i.requests) * 100
}

function behind(version: string | null, latest: string | null) {
  if (!version || !latest) return 0
  const [a, b] = version.split('.').map(Number)
  const [c, d] = latest.split('.').map(Number)
  return a === c ? Math.max(0, d - b) : c > a ? 99 : 0
}

function consoleUrl(id: string) {
  return `${location.protocol}//${id}.${location.host}/console/`
}

// ── Pieces ────────────────────────────────────────────────────

function Dash() {
  return <span className="muted">—</span>
}

function Spark({ values, state }: { values: (number | null)[]; state: State }) {
  const w = 76
  const h = 20
  if (state !== 'up' || values.every((v) => v === null)) return <svg className="spark" width={w} height={h} />
  const max = Math.max(1, ...values.map((v) => v ?? 0))
  const step = w / Math.max(1, values.length - 1)
  const segments: string[] = []
  let current = ''
  values.forEach((v, n) => {
    if (v === null) {
      if (current) segments.push(current)
      current = ''
      return
    }
    const x = (n * step).toFixed(1)
    const y = (h - 2 - (v / max) * (h - 4)).toFixed(1)
    current += `${current ? 'L' : 'M'}${x},${y}`
  })
  if (current) segments.push(current)
  return (
    <svg className="spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      {segments.map((d, n) => (
        <path key={n} d={d} />
      ))}
    </svg>
  )
}

function StatusBar({ instances }: { instances: Instance[] }) {
  const counts = { up: 0, down: 0, stopped: 0 }
  for (const i of instances) counts[i.state]++
  const total = Math.max(1, instances.length)
  return (
    <div className="statusbar">
      <div className="segments">
        {(['up', 'down', 'stopped'] as const).map((s) =>
          counts[s] ? <span key={s} className={`seg ${s}`} style={{ flexGrow: counts[s] / total }} /> : null,
        )}
      </div>
      <span className="count up">{counts.up} up</span>
      {counts.down > 0 && <span className="count down">{counts.down} down</span>}
      {counts.stopped > 0 && <span className="count stopped">{counts.stopped} stopped</span>}
    </div>
  )
}

type SortKey = 'name' | 'version' | 'requests' | 'errors' | 'avgMs' | 'bytes' | 'docs' | 'backup'

function sortValue(i: Instance, key: SortKey): number | string | null {
  switch (key) {
    case 'name':
      return `${ENV_ORDER[i.env]}${STATE_ORDER[i.state]}${i.name.toLowerCase()}`
    case 'version':
      return i.version ? Number(i.version.split('.')[0]) * 1000 + Number(i.version.split('.')[1]) : null
    case 'requests':
      return i.requests
    case 'errors':
      return errorPct(i)
    case 'avgMs':
      return i.avgMs
    case 'bytes':
      return i.bytes
    case 'docs':
      return i.docs
    case 'backup':
      return i.lastBackup ? new Date(i.lastBackup).getTime() : null
  }
}

function Header({ label, k, sort, setSort, num }: { label: string; k: SortKey; sort: [SortKey, 1 | -1]; setSort: (s: [SortKey, 1 | -1]) => void; num?: boolean }) {
  const active = sort[0] === k
  return (
    <th className={num ? 'num' : ''} aria-sort={active ? (sort[1] === 1 ? 'ascending' : 'descending') : 'none'}>
      <button onClick={() => setSort([k, active ? (sort[1] === 1 ? -1 : 1) : k === 'name' ? 1 : -1])}>
        {label}
        <span className={`arrow ${active ? '' : 'hidden'}`}>{sort[1] === 1 ? '↑' : '↓'}</span>
      </button>
    </th>
  )
}

// ── Detail panel ──────────────────────────────────────────────

function Chart({ series }: { series: Point[] }) {
  const [hover, setHover] = useState<number | null>(null)
  const w = 520
  const h = 160
  const pad = { l: 40, r: 8, t: 8, b: 20 }
  if (series.every((p) => p.requests === null)) return <div className="chart-empty">No requests in 24h</div>
  const max = Math.max(1, ...series.map((p) => p.requests ?? 0))
  const iw = w - pad.l - pad.r
  const ih = h - pad.t - pad.b
  const step = iw / series.length
  const x = (n: number) => pad.l + n * step + step / 2
  const y = (v: number) => pad.t + ih - (v / max) * ih
  let d = ''
  series.forEach((p, n) => {
    if (p.requests === null) return
    const prev = series[n - 1]
    d += `${d && prev && prev.requests !== null ? 'L' : 'M'}${x(n).toFixed(1)},${y(p.requests).toFixed(1)}`
  })
  const p = hover !== null ? series[hover] : null
  const time = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return (
    <div className="chart">
      <svg
        viewBox={`0 0 ${w} ${h}`}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          const n = Math.floor((((e.clientX - r.left) / r.width) * w - pad.l) / step)
          setHover(n >= 0 && n < series.length ? n : null)
        }}
        onMouseLeave={() => setHover(null)}
      >
        <line className="axis" x1={pad.l} x2={w - pad.r} y1={pad.t + ih} y2={pad.t + ih} />
        <line className="grid" x1={pad.l} x2={w - pad.r} y1={pad.t} y2={pad.t} />
        <text className="tick" x={pad.l - 6} y={pad.t + 4} textAnchor="end">{compact(max)}</text>
        <text className="tick" x={pad.l - 6} y={pad.t + ih + 4} textAnchor="end">0</text>
        {series.map((pt, n) =>
          pt.errors ? <rect key={n} className="err" x={x(n) - step / 2 + 0.5} width={Math.max(1, step - 1)} y={y(pt.errors)} height={pad.t + ih - y(pt.errors)} /> : null,
        )}
        <path className="line" d={d} />
        <text className="tick" x={pad.l} y={h - 4}>24h ago</text>
        <text className="tick" x={w - pad.r} y={h - 4} textAnchor="end">now</text>
        {p && hover !== null && (
          <>
            <line className="cursor" x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + ih} />
            {p.requests !== null && <circle className="dot" cx={x(hover)} cy={y(p.requests)} r={3} />}
          </>
        )}
      </svg>
      <div className="readout">
        {p ? (
          <>
            <span className="mono">{time(p.ts)}</span>
            <span>{p.requests === null ? '—' : compact(p.requests)} req</span>
            <span className={p.errors ? 'bad' : ''}>{p.errors ?? 0} err</span>
            <span>{p.avgMs === null ? '—' : `${p.avgMs} ms`}</span>
          </>
        ) : (
          <>
            <span className="legend line">requests / 10 min</span>
            <span className="legend err">errors</span>
          </>
        )}
      </div>
    </div>
  )
}

function Bars({ rows }: { rows: { label: string; value: number; display: string }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value))
  return (
    <div className="bars">
      {rows.map((r) => (
        <div className="bar-row" key={r.label} title={`${r.label}: ${r.display}`}>
          <span className="bar-label">{r.label}</span>
          <span className="bar-track">
            <span className="bar" style={{ width: `${(r.value / max) * 100}%` }} />
          </span>
          <span className="bar-value num">{r.display}</span>
        </div>
      ))}
    </div>
  )
}

function Panel({ id, latest, onClose }: { id: string; latest: string | null; onClose: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setDetail(null)
    const load = () =>
      fetch(`/api/instances/${id}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
        .then((d) => alive && (setDetail(d), setError(null)))
        .catch((e) => alive && setError(String(e.message || e)))
    load()
    const t = setInterval(load, POLL_MS * 2)
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', esc)
    return () => {
      alive = false
      clearInterval(t)
      window.removeEventListener('keydown', esc)
    }
  }, [id])

  const i = detail?.instance
  const label = (db: string, name: string) => (db === 'default' ? name : `${db}/${name}`)
  return (
    <aside className="panel" aria-label="Instance detail">
      <header>
        <div>
          <h2>
            {i?.name ?? id} {i && <span className={`pill ${i.env}`}>{i.env}</span>}
          </h2>
          {i && (
            <div className="sub mono">
              {i.host} · {i.version ? `v${i.version}` : 'unknown version'}
              {behind(i.version, latest) > 0 && <span className="behind">−{behind(i.version, latest)}</span>}
            </div>
          )}
        </div>
        <div className="panel-actions">
          {i && i.state === 'up' && (
            <a className="button primary" href={consoleUrl(id)} target="_blank" rel="noreferrer">
              Open console
            </a>
          )}
          <button className="button icon" onClick={onClose} aria-label="Close">×</button>
        </div>
      </header>

      {error && <div className="notice bad">{error}</div>}
      {!detail && !error && <div className="loading">Loading…</div>}
      {i && i.state !== 'up' && <div className={`notice ${i.state === 'down' ? 'bad' : ''}`}>{i.state === 'down' ? i.error || 'Unreachable' : 'Stopped'}</div>}
      {i && i.state === 'up' && !i.keyed && <div className="notice">No admin key</div>}

      {detail && i?.state === 'up' && i.keyed && (
        <>
          <section>
            <h3>Requests · 24h</h3>
            <Chart series={detail.series} />
          </section>

          {detail.top.length > 0 && (
            <section>
              <h3>Busiest collections · 24h</h3>
              <Bars rows={detail.top.map((t) => ({ label: label(t.database, t.collection), value: t.requests, display: compact(t.requests) }))} />
            </section>
          )}

          {detail.collections.length > 0 && (
            <section>
              <h3>Largest collections</h3>
              <Bars
                rows={[...detail.collections]
                  .sort((a, b) => b.count - a.count)
                  .slice(0, 12)
                  .map((c) => ({ label: label(c.database, c.name), value: c.count, display: `${compact(c.count)} · ${bytes(c.size)}` }))}
              />
            </section>
          )}

          {detail.indexes.length > 0 && (
            <section>
              <h3>Declared indexes</h3>
              <table className="mini">
                <tbody>
                  {detail.indexes.map((x) => (
                    <tr key={`${x.database}.${x.name}`}>
                      <td className="mono">{label(x.database, x.collection)}</td>
                      <td className="mono muted">{[...(x.equals || []), x.orderedBy].filter(Boolean).join(', ')}</td>
                      <td><span className={`state ${x.state.replace(' ', '-')}`}>{x.state}</span></td>
                      <td className="num">{compact(x.reads)} reads</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          <section>
            <h3>Backups</h3>
            {detail.backups.length === 0 ? (
              <div className="notice bad">Never backed up</div>
            ) : (
              <table className="mini">
                <tbody>
                  {detail.backups.map((b) => (
                    <tr key={b.name}>
                      <td className="mono">{new Date(b.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</td>
                      <td className={`num ${staleBackup(b.createdAt) ? 'bad' : ''}`}>{age(b.createdAt)} ago</td>
                      <td className="num">{bytes(b.size)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </aside>
  )
}

// ── App ───────────────────────────────────────────────────────

function App() {
  const [data, setData] = useState<{ latest: string | null; instances: Instance[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [env, setEnv] = useState<Env | 'all'>('all')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<[SortKey, 1 | -1]>(['name', 1])
  const [open, setOpen] = useState<string | null>(() => new URLSearchParams(location.search).get('i'))

  useEffect(() => {
    const load = () =>
      fetch('/api/fleet')
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
        .then((d) => (setData(d), setError(null)))
        .catch((e) => setError(String(e.message || e)))
    load()
    const t = setInterval(load, POLL_MS)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    const url = new URL(location.href)
    if (open) url.searchParams.set('i', open)
    else url.searchParams.delete('i')
    history.replaceState(null, '', url)
  }, [open])

  const all = data?.instances ?? []
  const q = query.trim().toLowerCase()
  const rows = all
    .filter((i) => env === 'all' || i.env === env)
    .filter((i) => !q || i.name.toLowerCase().includes(q) || i.host.toLowerCase().includes(q))
    .sort((a, b) => {
      if ((a.state === 'stopped') !== (b.state === 'stopped')) return a.state === 'stopped' ? 1 : -1
      const va = sortValue(a, sort[0])
      const vb = sortValue(b, sort[0])
      if (va === vb) return a.name.localeCompare(b.name)
      if (va === null) return 1
      if (vb === null) return -1
      return (va < vb ? -1 : 1) * sort[1]
    })
  const counts = { all: all.length, prod: 0, dev: 0, local: 0 }
  for (const i of all) counts[i.env]++

  return (
    <div className={`app ${open ? 'with-panel' : ''}`}>
      <header className="top">
        <div className="brand">
          <svg width="16" height="18" viewBox="0 0 16 18" aria-hidden="true">
            <ellipse cx="8" cy="3.5" rx="7" ry="2.8" fill="#146c43" />
            <path d="M1 6.5c0 1.6 3.1 2.8 7 2.8s7-1.2 7-2.8V10c0 1.6-3.1 2.8-7 2.8S1 11.6 1 10z" fill="#146c43" />
            <path d="M1 13c0 1.6 3.1 2.8 7 2.8s7-1.2 7-2.8v2c0 1.6-3.1 2.8-7 2.8S1 16.6 1 15z" fill="#146c43" />
          </svg>
          ezbase fleet
        </div>
        {data && <StatusBar instances={all} />}
        {data?.latest && (
          <div className="latest">
            Latest <span className="mono">{data.latest}</span>
          </div>
        )}
        <div className="chips" role="tablist">
          {(['all', 'prod', 'dev', 'local'] as const).map((e) => (
            <button key={e} role="tab" aria-selected={env === e} className={`chip ${env === e ? 'on' : ''}`} onClick={() => setEnv(e)} disabled={e !== 'all' && counts[e] === 0}>
              {e === 'all' ? 'All' : e[0].toUpperCase() + e.slice(1)}
              <span className="chip-count">{counts[e]}</span>
            </button>
          ))}
        </div>
        <input className="search" type="search" placeholder="Search instances" value={query} onChange={(e) => setQuery(e.target.value)} />
      </header>

      <main>
        {error && !data && <div className="notice bad">Fleet server unreachable: {error}</div>}
        {!data && !error && <div className="loading">Checking instances…</div>}
        {data && (
          <div className="table-wrap">
            <table className="fleet">
              <thead>
                <tr>
                  <th className="status-col" />
                  <Header label="Instance" k="name" sort={sort} setSort={setSort} />
                  <th>Host</th>
                  <Header label="Version" k="version" sort={sort} setSort={setSort} />
                  <Header label="Requests · 24h" k="requests" sort={sort} setSort={setSort} />
                  <Header label="Errors" k="errors" sort={sort} setSort={setSort} num />
                  <Header label="Avg" k="avgMs" sort={sort} setSort={setSort} num />
                  <Header label="Data" k="bytes" sort={sort} setSort={setSort} num />
                  <Header label="Docs" k="docs" sort={sort} setSort={setSort} num />
                  <Header label="Backup" k="backup" sort={sort} setSort={setSort} num />
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={11} className="empty">No instances match</td>
                  </tr>
                )}
                {rows.map((i) => {
                  const pct = errorPct(i)
                  const lag = behind(i.version, data.latest)
                  const backupAge = age(i.lastBackup)
                  const metrics = i.state === 'up' && i.keyed
                  return (
                    <tr key={i.id} className={`${i.state} ${open === i.id ? 'selected' : ''}`} onClick={() => setOpen(open === i.id ? null : i.id)}>
                      <td className="status-col">
                        <span className={`dot ${i.state}`} title={i.state === 'down' ? i.error || 'down' : i.state} />
                      </td>
                      <td>
                        <div className="name">
                          <span className="name-text">{i.name}</span>
                          <span className={`pill ${i.env}`}>{i.env}</span>
                          {i.state === 'up' && !i.keyed && <span className="nokey" title="No admin key">no key</span>}
                        </div>
                      </td>
                      <td className="mono host" title={i.host}>{i.host || <Dash />}</td>
                      <td className="mono">
                        {i.state === 'down' ? <span className="bad">down</span> : i.version ? `v${i.version}` : <Dash />}
                        {lag > 0 && i.state !== 'down' && <span className="behind">−{lag > 50 ? '' : lag}</span>}
                      </td>
                      <td>
                        <div className="traffic">
                          <Spark values={i.spark} state={metrics ? i.state : 'stopped'} />
                          <span className="num">{metrics ? rate(i.requests) : <Dash />}</span>
                        </div>
                      </td>
                      <td className={`num ${pct !== null && pct > 1 ? 'bad' : ''}`}>{metrics && pct !== null ? `${pct.toFixed(pct < 10 ? 2 : 1)}%` : <Dash />}</td>
                      <td className="num">{metrics && i.avgMs !== null && i.requests ? `${i.avgMs} ms` : <Dash />}</td>
                      <td className="num">{i.bytes !== null ? bytes(i.bytes) : <Dash />}</td>
                      <td className="num">{i.docs !== null ? compact(i.docs) : <Dash />}</td>
                      <td className={`num ${metrics && staleBackup(i.lastBackup) ? 'bad' : ''}`}>{metrics ? backupAge ?? 'never' : <Dash />}</td>
                      <td className="action">
                        {i.state === 'up' && (
                          <a className="button" href={consoleUrl(i.id)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                            Open console
                          </a>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </main>

      {open && <Panel id={open} latest={data?.latest ?? null} onClose={() => setOpen(null)} />}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
