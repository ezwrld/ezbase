import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Loader2, Plus, X } from 'lucide-react'
import { adminKey, api, dbBase, num } from '@/lib/api'
import type { EzDocument } from '@/hooks/useDocuments'
import { cellText } from './DocumentsTab'

const OPS = ['==', '!=', '<', '<=', '>', '>=', 'in'] as const
type Where = { field: string; op: (typeof OPS)[number]; value: string }
type Result = {
  docs: EzDocument[]
  ms: number | null
  index: string
  plan: { index?: string; read?: string; returned?: string } | null
}

/** Typed input: numbers, booleans, null and JSON stay typed; anything else is a string. `in` takes a comma list. */
function parseValue(raw: string, op: Where['op']): unknown {
  if (op === 'in') return raw.split(',').map((part) => parseValue(part.trim(), '=='))
  const text = raw.trim()
  if (text === '') return ''
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

const literal = (v: unknown) => JSON.stringify(v)

export function QueryTab({ database, collection }: { database: string; collection: string }) {
  const navigate = useNavigate()
  const [wheres, setWheres] = useState<Where[]>([{ field: '', op: '==', value: '' }])
  const [orderBy, setOrderBy] = useState('')
  const [order, setOrder] = useState<'asc' | 'desc'>('desc')
  const [limit, setLimit] = useState('25')
  const [fields, setFields] = useState<string[]>([])
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<Result | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [declared, setDeclared] = useState<string | null>(null)

  useEffect(() => {
    setResult(null)
    setError(null)
    setDeclared(null)
    setWheres([{ field: '', op: '==', value: '' }])
    setOrderBy('')
    api<EzDocument[]>(`${dbBase(database)}/collections/${encodeURIComponent(collection)}?limit=50`)
      .then((docs) => {
        const keys = new Set<string>()
        for (const doc of docs) {
          for (const [key, value] of Object.entries(doc.data)) {
            keys.add(key)
            if (value && typeof value === 'object' && !Array.isArray(value)) for (const sub of Object.keys(value)) keys.add(`${key}.${sub}`)
          }
        }
        setFields(['created', 'updated', ...[...keys].sort()])
      })
      .catch(() => setFields(['created', 'updated']))
  }, [database, collection])

  const active = wheres.filter((w) => w.field.trim())
  const sdk = useMemo(() => {
    let line = `ez.collection(${literal(collection)})`
    for (const w of active) line += `.where(${literal(w.field)}, ${literal(w.op)}, ${literal(parseValue(w.value, w.op))})`
    if (orderBy) line += `.orderBy(${literal(orderBy)}, ${literal(order)})`
    line += `.limit(${Number(limit) || 25})`
    return line
  }, [active, orderBy, order, limit, collection])

  const run = async (e?: React.FormEvent) => {
    e?.preventDefault()
    setRunning(true)
    setError(null)
    setDeclared(null)
    const params = new URLSearchParams({ limit: String(Number(limit) || 25) })
    if (active.length) params.set('where', JSON.stringify(active.map((w) => [w.field.trim(), w.op, parseValue(w.value, w.op)])))
    if (orderBy) {
      params.set('orderBy', orderBy)
      params.set('order', order)
    }
    try {
      const res = await fetch(`${dbBase(database)}/collections/${encodeURIComponent(collection)}?${params}`, {
        headers: { Authorization: `Bearer ${adminKey()}`, 'X-Ezbase-Explain': '1' },
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body?.error || `${res.status}`)
      const timing = res.headers.get('server-timing')?.match(/dur=([\d.]+)/)
      const plan = res.headers.get('x-ezbase-plan')
      setResult({
        docs: body,
        ms: timing ? Number(timing[1]) : null,
        index: res.headers.get('x-ezbase-index') || '',
        plan: plan ? Object.fromEntries(plan.split(';').map((part) => part.trim().split('=') as [string, string])) : null,
      })
    } catch (err) {
      setError((err as Error).message)
      setResult(null)
    } finally {
      setRunning(false)
    }
  }

  const suggestion = result?.index.startsWith('undeclared; add ') ? result.index.slice('undeclared; add '.length) : null
  const declare = async () => {
    if (!suggestion) return
    try {
      const current = await api<{ declared: { equals?: string[]; orderedBy?: string }[] }>(
        `${dbBase(database)}/collections/${encodeURIComponent(collection)}/indexes`
      )
      const keep = current.declared.map(({ equals, orderedBy }) => ({ ...(equals?.length ? { equals } : {}), ...(orderedBy ? { orderedBy } : {}) }))
      await api(`/api/indexes/collections/${encodeURIComponent(collection)}`, {
        method: 'PUT',
        body: JSON.stringify({ indexes: [...keep, JSON.parse(suggestion)] }),
      })
      setDeclared(suggestion)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const columns = useMemo(() => {
    if (!result) return []
    const picked = [...new Set([...active.map((w) => w.field.trim()), orderBy].filter((f) => f && f !== 'created' && f !== 'updated' && !f.includes('.')))]
    const counts = new Map<string, number>()
    for (const doc of result.docs) for (const [k, v] of Object.entries(doc.data)) if (v === null || typeof v !== 'object') counts.set(k, (counts.get(k) ?? 0) + 1)
    for (const [k] of [...counts].sort((a, b) => b[1] - a[1])) if (picked.length < 5 && !picked.includes(k) && k !== 'id') picked.push(k)
    return picked
  }, [result, active, orderBy])

  const label = result ? indexLabel(result) : null

  return (
    <div className="flex-1 overflow-y-auto px-6 py-5">
      <datalist id="query-fields">
        {fields.map((f) => <option key={f} value={f} />)}
      </datalist>
      <form onSubmit={run} className="grid grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] gap-6 rounded-md border border-zinc-200 bg-white p-5">
        <div className="grid content-start gap-3">
          {wheres.map((w, i) => (
            <div key={i} className="grid grid-cols-[72px_minmax(0,1fr)_84px_minmax(0,1fr)_28px] items-center gap-2">
              <span className="text-sm text-zinc-500">{i === 0 ? 'where' : 'and'}</span>
              <input
                list="query-fields"
                value={w.field}
                onChange={(e) => setWheres(wheres.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)))}
                placeholder="field"
                className="rounded border border-zinc-300 px-2.5 py-1.5 font-mono text-sm outline-none focus:border-sky-500"
              />
              <select
                value={w.op}
                onChange={(e) => setWheres(wheres.map((x, j) => (j === i ? { ...x, op: e.target.value as Where['op'] } : x)))}
                className="rounded border border-zinc-300 bg-white px-2 py-1.5 font-mono text-sm outline-none focus:border-sky-500"
              >
                {OPS.map((op) => <option key={op}>{op}</option>)}
              </select>
              <input
                value={w.value}
                onChange={(e) => setWheres(wheres.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                placeholder={w.op === 'in' ? 'a, b, c' : 'value'}
                className="rounded border border-zinc-300 px-2.5 py-1.5 font-mono text-sm outline-none focus:border-sky-500"
              />
              {wheres.length > 1 ? (
                <button type="button" onClick={() => setWheres(wheres.filter((_, j) => j !== i))} className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700" aria-label="Remove condition">
                  <X className="h-4 w-4" />
                </button>
              ) : <span />}
            </div>
          ))}
          <button type="button" onClick={() => setWheres([...wheres, { field: '', op: '==', value: '' }])} className="flex w-fit items-center gap-1 pl-[80px] text-sm text-sky-600 hover:text-sky-700">
            <Plus className="h-3.5 w-3.5" /> where
          </button>
          <div className="grid grid-cols-[72px_minmax(0,1fr)_96px] items-center gap-2">
            <span className="text-sm text-zinc-500">order by</span>
            <input list="query-fields" value={orderBy} onChange={(e) => setOrderBy(e.target.value)} placeholder="created" className="rounded border border-zinc-300 px-2.5 py-1.5 font-mono text-sm outline-none focus:border-sky-500" />
            <select value={order} onChange={(e) => setOrder(e.target.value as 'asc' | 'desc')} className="rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm outline-none focus:border-sky-500">
              <option>desc</option>
              <option>asc</option>
            </select>
          </div>
          <div className="grid grid-cols-[72px_120px] items-center gap-2">
            <span className="text-sm text-zinc-500">limit</span>
            <input value={limit} onChange={(e) => setLimit(e.target.value.replace(/\D/g, ''))} className="rounded border border-zinc-300 px-2.5 py-1.5 font-mono text-sm tabular-nums outline-none focus:border-sky-500" />
          </div>
          <div className="pl-[80px]">
            <button type="submit" disabled={running} className="flex items-center gap-2 rounded-md bg-sky-500 px-4 py-1.5 text-sm font-medium text-white hover:bg-sky-600 disabled:opacity-60">
              {running && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Run
            </button>
          </div>
        </div>
        <pre className="h-fit overflow-x-auto whitespace-pre-wrap break-all rounded bg-zinc-50 p-3 font-mono text-[12.5px] leading-relaxed text-zinc-700">{sdk}</pre>
      </form>

      {error && <div className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      {result && (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-md border border-zinc-200 bg-white px-4 py-3 text-sm">
            <span className="font-semibold text-zinc-900">{num(result.docs.length)} documents</span>
            {result.ms !== null && <span className="tabular-nums text-zinc-600">{result.ms.toFixed(1)} ms</span>}
            {result.plan?.read && <span className="tabular-nums text-zinc-600">read {num(Number(result.plan.read))} · returned {num(Number(result.plan.returned ?? 0))}</span>}
            {label && (
              <span className="flex items-center gap-2">
                <span className="rounded px-1.5 py-0.5 text-[11px] font-medium" style={{ background: label.bg, color: label.fg }}>{label.text}</span>
                {label.detail && <span className="font-mono text-xs text-zinc-600">{label.detail}</span>}
              </span>
            )}
            {suggestion && (
              <span className="ml-auto flex items-center gap-3">
                <span className="font-mono text-xs text-zinc-600">add index {suggestion}</span>
                {declared === suggestion ? (
                  <span className="text-xs font-medium text-emerald-700">Declared</span>
                ) : (
                  <button type="button" onClick={declare} className="rounded-md border border-zinc-300 px-2.5 py-1 text-sm font-medium text-zinc-800 hover:bg-zinc-50">Add index</button>
                )}
              </span>
            )}
          </div>

          <div className="mt-4 overflow-x-auto rounded-md border border-zinc-200 bg-white">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 bg-zinc-50 text-left text-xs text-zinc-500">
                  <th className="py-2 pl-4 font-medium">id</th>
                  {columns.map((c) => <th key={c} className="py-2 pr-4 font-medium">{c}</th>)}
                </tr>
              </thead>
              <tbody>
                {result.docs.length === 0 && (
                  <tr><td colSpan={columns.length + 1} className="py-10 text-center text-sm text-zinc-500">No documents match</td></tr>
                )}
                {result.docs.map((doc) => (
                  <tr
                    key={doc.id}
                    onClick={() => navigate(`/data/${encodeURIComponent(database)}/${encodeURIComponent(collection)}/documents/${encodeURIComponent(doc.id)}`)}
                    className="cursor-pointer border-b border-zinc-100 last:border-0 hover:bg-zinc-50"
                  >
                    <td className="max-w-[240px] truncate py-2 pl-4 font-mono text-[13px] text-zinc-900">{doc.id}</td>
                    {columns.map((c) => (
                      <td key={c} className="max-w-[320px] truncate py-2 pr-4 font-mono text-[13px] text-zinc-700" title={cellText(doc.data[c])}>{cellText(doc.data[c])}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

function indexLabel(result: Result): { text: string; detail?: string; bg: string; fg: string } | null {
  const label = result.index
  if (!label) return null
  if (label.startsWith('automatic ')) return { text: 'automatic', detail: label.slice('automatic '.length), bg: '#dcfce7', fg: '#15803d' }
  if (label.startsWith('declared ')) return { text: 'declared', detail: label.slice('declared '.length), bg: '#e0f2fe', fg: '#0369a1' }
  if (label.startsWith('built-in ')) return { text: 'built-in', detail: label.slice('built-in '.length), bg: '#f4f4f5', fg: '#52525b' }
  return { text: result.plan?.index === 'seq scan' || label === 'full scan' ? 'seq scan' : 'no index', bg: '#fef3c7', fg: '#b45309' }
}
