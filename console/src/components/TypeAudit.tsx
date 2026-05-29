import { useState, useEffect } from 'react'
import { Loader2, AlertCircle, Play, Copy, Check, ChevronDown, ChevronRight, FileCode, Layers, Hash, Sigma } from 'lucide-react'
import { useCollections } from '@/hooks/useCollections'
import { PieChart, getColor, type PieSlice } from './PieChart'

interface EnumValue {
  value: unknown
  count: number
  pct: number
}
interface FieldStat {
  path: string
  types: Record<string, number>
  presence: number
  presencePct: number
  samples: unknown[]
  enumValues?: EnumValue[]
}

interface Cluster {
  count: number
  pct: number
  sampleIds: string[]
  extraFields: string[]
  missingFields: string[]
  isCanonical: boolean
  label: string
}

interface ExtractedField {
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

interface ExtractedType {
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

interface AuditResult {
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

interface Props {
  adminKey: string
  database: string
  initialCollection?: string | null
}

const SAMPLE_OPTIONS = [1000, 10000, 50000, 100000]

export function TypeAudit({ adminKey, database, initialCollection }: Props) {
  const { collections, loading: colLoading } = useCollections(database, adminKey)
  const [collection, setCollection] = useState<string>(initialCollection || '')
  const [sample, setSample] = useState(10000)
  const [result, setResult] = useState<AuditResult | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (initialCollection) setCollection(initialCollection)
  }, [initialCollection])

  useEffect(() => {
    if (!collection && collections.length > 0) setCollection(collections[0])
  }, [collections, collection])

  useEffect(() => { setResult(null); setError(null) }, [collection, database])

  async function run() {
    if (!collection) return
    setRunning(true); setError(null)
    try {
      const url = `/api/db/${encodeURIComponent(database)}/collections/${encodeURIComponent(collection)}/audit?sample=${sample}`
      const res = await fetch(url, { headers: { Authorization: `Bearer ${adminKey}` } })
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
      setResult((await res.json()) as AuditResult)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Audit failed')
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-zinc-200 bg-white px-5 py-3">
        <div className="flex items-center gap-3">
          <h2 className="font-mono text-base font-semibold text-zinc-900">Type Audit</h2>
          {result && (
            <span className="text-xs text-zinc-500">
              {result.scanned.toLocaleString()} of {result.totalDocs.toLocaleString()} doc{result.totalDocs !== 1 ? 's' : ''}
              {result.sampled && <span className="ml-1 text-amber-600">(sampled)</span>}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <select
            value={collection}
            onChange={(e) => setCollection(e.target.value)}
            disabled={colLoading || collections.length === 0}
            className="rounded border border-zinc-300 bg-white px-2 py-1 font-mono text-xs text-zinc-800 outline-none focus:border-sky-400"
          >
            {collections.length === 0 && <option value="">No collections</option>}
            {collections.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select
            value={sample}
            onChange={(e) => setSample(Number(e.target.value))}
            className="rounded border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-800 outline-none focus:border-sky-400"
            title="Max docs to scan"
          >
            {SAMPLE_OPTIONS.map((n) => (
              <option key={n} value={n}>up to {n.toLocaleString()}</option>
            ))}
          </select>
          <button
            onClick={run}
            disabled={running || !collection}
            className="flex items-center gap-1.5 rounded bg-sky-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-sky-600 disabled:opacity-50"
          >
            {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
            {running ? 'Running...' : 'Run audit'}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto bg-zinc-50">
        {error && (
          <div className="m-5 flex items-center gap-2 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">
            <AlertCircle className="h-3.5 w-3.5" /> {error}
          </div>
        )}

        {!result && !error && (
          <Empty />
        )}

        {result && (
          <div className="space-y-5 p-5">
            <SummaryCards result={result} />
            <VariantsPanel result={result} />
            <ExtractedTypesPanel result={result} />
            <FieldsPanel result={result} />
          </div>
        )}
      </div>
    </div>
  )
}

function Empty() {
  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="max-w-md text-center">
        <p className="font-mono text-sm text-zinc-500">
          Scans the collection, infers shapes, extracts reusable types, and shows distribution + per-field stats.
        </p>
        <p className="mt-2 text-xs text-zinc-400">
          Click <span className="font-mono">Run audit</span> to start.
        </p>
      </div>
    </div>
  )
}

function SummaryCards({ result }: { result: AuditResult }) {
  const cards = [
    { icon: Hash, label: 'Docs scanned', value: result.scanned.toLocaleString(), sub: `of ${result.totalDocs.toLocaleString()} total` },
    { icon: FileCode, label: 'Inferred types', value: result.types.length.toLocaleString(), sub: result.rootTypeName ? `root: ${result.rootTypeName}` : '' },
    { icon: Layers, label: 'Shape variants', value: result.clusters.length.toLocaleString(), sub: result.clusters[0] ? `${formatPct(result.clusters[0].pct)} canonical` : '' },
    { icon: Sigma, label: 'Observed fields', value: result.fields.length.toLocaleString(), sub: 'across all paths' },
  ]
  return (
    <div className="grid grid-cols-4 gap-3">
      {cards.map((c, i) => (
        <div key={i} className="rounded-lg border border-zinc-200 bg-white p-3">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
            <c.icon className="h-3 w-3" />
            {c.label}
          </div>
          <div className="mt-1 font-mono text-2xl font-semibold text-zinc-900">{c.value}</div>
          {c.sub && <div className="mt-0.5 font-mono text-[11px] text-zinc-500">{c.sub}</div>}
        </div>
      ))}
    </div>
  )
}

function VariantsPanel({ result }: { result: AuditResult }) {
  const [expanded, setExpanded] = useState<number | null>(0)
  const slices: PieSlice[] = result.clusters.map((c, i) => ({
    label: c.label,
    value: c.count,
    color: c.isCanonical ? '#34d399' : getColor(i + 1),
  }))
  const total = result.scanned

  return (
    <section className="rounded-lg border border-zinc-200 bg-white">
      <header className="border-b border-zinc-200 px-4 py-2.5">
        <h3 className="text-sm font-semibold text-zinc-900">Shape Distribution</h3>
        <p className="mt-0.5 text-[11px] text-zinc-500">How documents are distributed across distinct structural shapes.</p>
      </header>
      <div className="flex flex-col gap-5 p-5 lg:flex-row lg:items-start">
        <div className="flex shrink-0 flex-col items-center gap-3">
          <PieChart slices={slices} size={180} />
          <div className="font-mono text-xs text-zinc-500">{total.toLocaleString()} docs</div>
        </div>
        <div className="flex-1 min-w-0">
          {result.clusters.map((c, i) => {
            const open = expanded === i
            const color = c.isCanonical ? '#34d399' : getColor(i + 1)
            return (
              <div key={i} className="border-b border-zinc-100 last:border-b-0">
                <button
                  onClick={() => setExpanded(open ? null : i)}
                  className="flex w-full items-center gap-3 py-2.5 text-left transition-colors hover:bg-zinc-50"
                >
                  {open ? <ChevronDown className="h-3.5 w-3.5 text-zinc-400" /> : <ChevronRight className="h-3.5 w-3.5 text-zinc-400" />}
                  <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: color }} />
                  <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-medium ${c.isCanonical ? 'bg-emerald-100 text-emerald-700' : 'bg-zinc-100 text-zinc-600'}`}>
                    {c.isCanonical ? 'canonical' : `variant ${i + 1}`}
                  </span>
                  <span className="flex-1 truncate text-xs text-zinc-700">{c.label}</span>
                  <span className="font-mono text-xs tabular-nums text-zinc-500">{c.count.toLocaleString()}</span>
                  <span className="w-12 text-right font-mono text-xs tabular-nums text-zinc-900">{formatPct(c.pct)}</span>
                </button>
                {open && (
                  <div className="space-y-2 bg-zinc-50/60 px-4 py-3 text-xs">
                    {c.extraFields.length > 0 && <DiffList title="Extra fields" color="emerald" items={c.extraFields} />}
                    {c.missingFields.length > 0 && <DiffList title="Missing fields" color="amber" items={c.missingFields} />}
                    {c.extraFields.length === 0 && c.missingFields.length === 0 && !c.isCanonical && (
                      <div className="text-zinc-500">Rolled-up bucket — top variants shown above.</div>
                    )}
                    {c.sampleIds.length > 0 && (
                      <div>
                        <div className="mb-1 text-[10px] font-medium uppercase tracking-widest text-zinc-500">Sample IDs</div>
                        <div className="flex flex-wrap gap-1">
                          {c.sampleIds.map((id) => (
                            <code key={id} className="rounded bg-white px-1.5 py-0.5 font-mono text-[11px] text-zinc-700 ring-1 ring-zinc-200">{id}</code>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}

function DiffList({ title, color, items }: { title: string; color: 'emerald' | 'amber'; items: string[] }) {
  const dot = color === 'emerald' ? 'bg-emerald-500' : 'bg-amber-500'
  return (
    <div>
      <div className="mb-1 text-[10px] font-medium uppercase tracking-widest text-zinc-500">{title}</div>
      <div className="flex flex-wrap gap-1">
        {items.map((p) => (
          <span key={p} className="inline-flex items-center gap-1.5 rounded bg-white px-1.5 py-0.5 font-mono text-[11px] text-zinc-800 ring-1 ring-zinc-200">
            <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
            {p}
          </span>
        ))}
      </div>
    </div>
  )
}

function ExtractedTypesPanel({ result }: { result: AuditResult }) {
  const [copiedAll, setCopiedAll] = useState(false)

  function copyAll() {
    navigator.clipboard.writeText(result.canonicalInterface)
    setCopiedAll(true)
    setTimeout(() => setCopiedAll(false), 1500)
  }

  return (
    <section className="rounded-lg border border-zinc-200 bg-white">
      <header className="flex items-center justify-between border-b border-zinc-200 px-4 py-2.5">
        <div>
          <h3 className="text-sm font-semibold text-zinc-900">Inferred Types ({result.types.length})</h3>
          <p className="mt-0.5 text-[11px] text-zinc-500">
            Root collection type plus any shape reused across paths or substantial enough to deserve a name.
            Per-field <span className="font-mono">?</span> means &lt;100% presence in this shape's instances.
          </p>
        </div>
        <button
          onClick={copyAll}
          className="flex items-center gap-1 rounded border border-zinc-300 bg-white px-2 py-1 text-[11px] text-zinc-700 transition-colors hover:bg-zinc-50"
        >
          {copiedAll ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
          {copiedAll ? 'Copied' : 'Copy all'}
        </button>
      </header>
      <div className="divide-y divide-zinc-200">
        {result.types.map((t) => <TypeCard key={t.name} type={t} />)}
      </div>
    </section>
  )
}

function TypeCard({ type }: { type: ExtractedType }) {
  const [open, setOpen] = useState(type.isRoot)
  const [copied, setCopied] = useState(false)

  function copyOne() {
    navigator.clipboard.writeText(type.source)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="p-4">
      <div className="flex items-start justify-between gap-3">
        <button onClick={() => setOpen(!open)} className="group flex flex-1 items-start gap-2 text-left">
          {open ? <ChevronDown className="mt-0.5 h-3.5 w-3.5 text-zinc-400" /> : <ChevronRight className="mt-0.5 h-3.5 w-3.5 text-zinc-400" />}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <code className="font-mono text-sm font-semibold text-zinc-900">{type.name}</code>
              {type.isRoot && (
                <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-medium text-sky-700">root</span>
              )}
              {!type.isRoot && type.paths.length >= 2 && (
                <span className="rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium text-violet-700">
                  reused {type.paths.length}×
                </span>
              )}
              <span className="font-mono text-[11px] text-zinc-500">
                {type.requiredCount} required · {type.optionalCount} optional
              </span>
            </div>
            <div className="mt-1 font-mono text-[11px] text-zinc-500">
              {type.occurrences.toLocaleString()} instance{type.occurrences === 1 ? '' : 's'} ({formatPct(type.occurrencePct)})
              {!type.isRoot && type.paths.length > 0 && (
                <span className="ml-2 text-zinc-400">at {type.paths.slice(0, 3).join(', ')}{type.paths.length > 3 ? `, +${type.paths.length - 3} more` : ''}</span>
              )}
            </div>
          </div>
        </button>
        <button
          onClick={copyOne}
          className="flex shrink-0 items-center gap-1 rounded border border-zinc-200 bg-white px-2 py-1 text-[11px] text-zinc-600 transition-colors hover:bg-zinc-50"
        >
          {copied ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
        </button>
      </div>

      {open && (
        <div className="mt-3 space-y-3">
          <pre className="overflow-x-auto rounded border border-zinc-200 bg-zinc-50 p-3 font-mono text-xs leading-relaxed text-zinc-800">
            {type.source}
          </pre>
          <FieldTable fields={type.fields} />
        </div>
      )}
    </div>
  )
}

function FieldTable({ fields }: { fields: ExtractedField[] }) {
  return (
    <div className="overflow-x-auto rounded border border-zinc-200">
      <table className="w-full text-xs">
        <thead className="bg-zinc-50 text-[10px] uppercase tracking-widest text-zinc-500">
          <tr>
            <th className="px-3 py-2 text-left font-medium">Field</th>
            <th className="px-3 py-2 text-left font-medium">Type</th>
            <th className="px-3 py-2 text-left font-medium">Required</th>
            <th className="px-3 py-2 text-right font-medium">Presence</th>
            <th className="px-3 py-2 text-left font-medium">Type breakdown</th>
            <th className="px-3 py-2 text-left font-medium">Samples</th>
          </tr>
        </thead>
        <tbody>
          {fields.map((f) => (
            <tr key={f.name} className="border-t border-zinc-100">
              <td className="px-3 py-2 font-mono text-zinc-900">
                <div className="flex items-center gap-1.5">
                  <span>{f.name}{f.optional && <span className="text-zinc-400">?</span>}</span>
                  {f.enumValues && (
                    <span className="rounded bg-violet-100 px-1.5 py-0.5 text-[9px] font-medium text-violet-700">
                      enum · {f.enumValues.length}
                    </span>
                  )}
                </div>
              </td>
              <td className="px-3 py-2 font-mono text-zinc-700">
                <code className="whitespace-pre-wrap">{f.type}</code>
              </td>
              <td className="px-3 py-2">
                {f.optional
                  ? <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">optional</span>
                  : <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">required</span>}
              </td>
              <td className="px-3 py-2 text-right">
                <div className="inline-flex items-center gap-2">
                  <PresenceBar pct={f.pct} />
                  <span className="font-mono tabular-nums text-zinc-700">
                    {f.presence.toLocaleString()}<span className="text-zinc-400">/</span>{f.occurrences.toLocaleString()}
                  </span>
                  <span className="w-12 text-right font-mono tabular-nums text-zinc-900">{formatPct(f.pct)}</span>
                </div>
              </td>
              <td className="px-3 py-2">
                {f.enumValues ? <EnumChips values={f.enumValues} /> : (
                  <div className="flex flex-wrap gap-1">
                    {Object.entries(f.typeBreakdown)
                      .sort((a, b) => b[1] - a[1])
                      .map(([t, n]) => (
                        <span key={t} className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] text-zinc-700">
                          {t} · {n.toLocaleString()}
                        </span>
                      ))}
                  </div>
                )}
              </td>
              <td className="px-3 py-2 font-mono text-[11px] text-zinc-500">
                {f.samples.length === 0
                  ? <span className="text-zinc-300">—</span>
                  : f.samples.map((s, i) => <span key={i} className="mr-2">{previewValue(s)}</span>)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function FieldsPanel({ result }: { result: AuditResult }) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white">
      <header className="border-b border-zinc-200 px-4 py-2.5">
        <h3 className="text-sm font-semibold text-zinc-900">All Observed Paths ({result.fields.length})</h3>
        <p className="mt-0.5 text-[11px] text-zinc-500">Flat view: every path that appeared in any document, including nested + array element paths.</p>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-zinc-50 text-[10px] uppercase tracking-widest text-zinc-500">
            <tr>
              <th className="px-4 py-2 text-left font-medium">Path</th>
              <th className="px-4 py-2 text-left font-medium">Types</th>
              <th className="px-4 py-2 text-right font-medium">Presence</th>
              <th className="px-4 py-2 text-left font-medium">Samples</th>
            </tr>
          </thead>
          <tbody>
            {result.fields.map((f) => (
              <tr key={f.path} className="border-t border-zinc-100">
                <td className="px-4 py-2 font-mono text-zinc-900">{f.path}</td>
                <td className="px-4 py-2">
                  {f.enumValues ? <EnumChips values={f.enumValues} /> : (
                    <div className="flex flex-wrap gap-1">
                      {Object.entries(f.types).sort((a, b) => b[1] - a[1]).map(([t, n]) => (
                        <span key={t} className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] text-zinc-700">
                          {t} · {n.toLocaleString()}
                        </span>
                      ))}
                    </div>
                  )}
                </td>
                <td className="px-4 py-2 text-right">
                  <div className="inline-flex items-center gap-2">
                    <PresenceBar pct={f.presencePct} />
                    <span className="font-mono tabular-nums text-zinc-700">{f.presence.toLocaleString()}<span className="text-zinc-400">/</span>{result.scanned.toLocaleString()}</span>
                    <span className="w-12 text-right font-mono tabular-nums text-zinc-900">{formatPct(f.presencePct)}</span>
                  </div>
                </td>
                <td className="px-4 py-2 font-mono text-[11px] text-zinc-500">
                  {f.samples.length === 0
                    ? <span className="text-zinc-300">—</span>
                    : f.samples.map((s, i) => <span key={i} className="mr-2">{previewValue(s)}</span>)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function EnumChips({ values }: { values: EnumValue[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {values.map((v, i) => (
        <span
          key={i}
          className="inline-flex items-center gap-1 rounded bg-violet-50 px-1.5 py-0.5 font-mono text-[10px] text-violet-800 ring-1 ring-violet-200"
          title={`${v.count.toLocaleString()} occurrences (${formatPct(v.pct)})`}
        >
          <span className="font-medium">{formatLiteralForChip(v.value)}</span>
          <span className="text-violet-500">·</span>
          <span className="tabular-nums">{v.count.toLocaleString()}</span>
          <span className="text-violet-500 tabular-nums">({formatPct(v.pct)})</span>
        </span>
      ))}
    </div>
  )
}

function formatLiteralForChip(v: unknown): string {
  if (typeof v === 'string') {
    const s = v.length > 24 ? v.slice(0, 24) + '…' : v
    return JSON.stringify(s)
  }
  if (typeof v === 'number') return String(v)
  return JSON.stringify(v)
}

function PresenceBar({ pct }: { pct: number }) {
  const width = Math.max(2, Math.round(pct * 60))
  const color = pct >= 0.95 ? 'bg-emerald-500' : pct >= 0.5 ? 'bg-sky-500' : 'bg-amber-500'
  return (
    <span className="inline-block h-1.5 w-[60px] overflow-hidden rounded-full bg-zinc-100">
      <span className={`block h-full ${color}`} style={{ width: `${width}px` }} />
    </span>
  )
}

function formatPct(p: number): string {
  if (p >= 0.999) return '100%'
  if (p < 0.001) return '<0.1%'
  if (p < 0.01) return `${(p * 100).toFixed(2)}%`
  if (p < 0.1) return `${(p * 100).toFixed(1)}%`
  return `${Math.round(p * 100)}%`
}

function previewValue(v: unknown): string {
  if (typeof v === 'string') {
    const s = v.length > 32 ? v.slice(0, 32) + '…' : v
    return JSON.stringify(s)
  }
  if (v === null) return 'null'
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return JSON.stringify(v).slice(0, 40)
}
