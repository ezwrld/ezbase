import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, Loader2 } from 'lucide-react'
import { api, ago, bytes, dbBase, num } from '@/lib/api'
import { Notice } from './ShapesTab'

type Kind = 'primary' | 'built-in' | 'declared' | 'automatic' | 'legacy'
type Declared = { equals?: string[]; orderedBy?: string }
type Indexes = {
  tableBytes: number
  indexBytes: number
  indexes: { name: string; kind: Kind; fields: string[]; method: string; sizeBytes: number; reads: number; valid: boolean }[]
  declared: (Declared & { name: string | null; built: boolean })[]
  suggested: { index: Declared; queries: number; lastSeen: number }[]
  writable: boolean
}

const KIND_STYLE: Record<Kind, { bg: string; fg: string }> = {
  primary: { bg: '#f4f4f5', fg: '#52525b' },
  'built-in': { bg: '#f4f4f5', fg: '#52525b' },
  declared: { bg: '#e0f2fe', fg: '#0369a1' },
  automatic: { bg: '#dcfce7', fg: '#15803d' },
  legacy: { bg: '#fef3c7', fg: '#b45309' },
}

const describe = (index: Declared) =>
  [index.equals?.length ? `equals: [${index.equals.join(', ')}]` : '', index.orderedBy ? `orderedBy: ${index.orderedBy}` : '']
    .filter(Boolean)
    .join(', ')

export function IndexesTab({ database, collection }: { database: string; collection: string }) {
  const [data, setData] = useState<Indexes | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)
  const [equals, setEquals] = useState('')
  const [orderedBy, setOrderedBy] = useState('')

  const load = useCallback(
    () =>
      api<Indexes>(`${dbBase(database)}/collections/${encodeURIComponent(collection)}/indexes`)
        .then((d) => {
          setData(d)
          setError(null)
        })
        .catch((e) => setError(e.status === 404 && /Document not found/.test(e.message) ? 'Indexes need ezbase 1.17 or later on this instance' : e.message)),
    [database, collection]
  )

  useEffect(() => {
    setData(null)
    load()
  }, [load])

  const building = data?.declared.some((d) => !d.built)
  useEffect(() => {
    if (!building) return
    const t = setInterval(load, 3000)
    return () => clearInterval(t)
  }, [building, load])

  const writeDeclared = async (next: Declared[]) => {
    setBusy(true)
    setActionError(null)
    try {
      await api(`/api/indexes/collections/${encodeURIComponent(collection)}`, {
        method: 'PUT',
        body: JSON.stringify({ indexes: next }),
      })
      await load()
      // Builds and drops run in the background; look again once they have had a moment.
      setTimeout(load, 2000)
      return true
    } catch (e) {
      setActionError((e as Error).message)
      return false
    } finally {
      setBusy(false)
    }
  }

  if (error) return <Notice icon={<AlertCircle className="h-4 w-4" />} text={error} tone="error" />
  if (!data) return <Notice icon={<Loader2 className="h-4 w-4 animate-spin" />} text="Loading indexes" />

  const current: Declared[] = data.declared.map(({ equals, orderedBy }) => ({ ...(equals?.length ? { equals } : {}), ...(orderedBy ? { orderedBy } : {}) }))
  const declare = (index: Declared) => writeDeclared([...current, index])
  const remove = (name: string | null) => writeDeclared(current.filter((_, i) => data.declared[i]?.name !== name))
  const drop = async (name: string) => {
    if (!window.confirm(`Drop ${name}?`)) return
    setBusy(true)
    setActionError(null)
    try {
      setData(await api<Indexes>(`${dbBase(database)}/collections/${encodeURIComponent(collection)}/indexes/${encodeURIComponent(name)}`, { method: 'DELETE' }))
    } catch (e) {
      setActionError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const submitAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    const fields = equals.split(',').map((f) => f.trim()).filter(Boolean)
    const index: Declared = { ...(fields.length ? { equals: fields } : {}), ...(orderedBy.trim() ? { orderedBy: orderedBy.trim() } : {}) }
    if (await declare(index)) {
      setAdding(false)
      setEquals('')
      setOrderedBy('')
    }
  }

  const pending = data.declared.filter((d) => !d.built)

  return (
    <div className="flex-1 overflow-y-auto px-6 py-5">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="font-mono text-2xl font-semibold text-zinc-900">{collection}</h1>
        <button
          type="button"
          disabled={!data.writable || busy}
          title={data.writable ? undefined : 'indexes.json is mounted read-only'}
          onClick={() => setAdding((v) => !v)}
          className="rounded-md bg-sky-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-600 disabled:cursor-not-allowed disabled:bg-zinc-300"
        >
          Add index
        </button>
      </div>

      {adding && (
        <form onSubmit={submitAdd} className="mb-4 flex flex-wrap items-end gap-3 rounded-md border border-zinc-200 bg-white p-4">
          <label className="grid gap-1 text-xs text-zinc-500">
            equals
            <input
              value={equals}
              onChange={(e) => setEquals(e.target.value)}
              placeholder="status, orgId"
              className="w-64 rounded border border-zinc-300 px-2.5 py-1.5 font-mono text-sm text-zinc-900 outline-none focus:border-sky-500"
              autoFocus
            />
          </label>
          <label className="grid gap-1 text-xs text-zinc-500">
            orderedBy
            <input
              value={orderedBy}
              onChange={(e) => setOrderedBy(e.target.value)}
              placeholder="createdAt"
              className="w-48 rounded border border-zinc-300 px-2.5 py-1.5 font-mono text-sm text-zinc-900 outline-none focus:border-sky-500"
            />
          </label>
          <button type="submit" disabled={busy} className="rounded-md bg-sky-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-600 disabled:opacity-50">
            Declare
          </button>
          <button type="button" onClick={() => setAdding(false)} className="px-2 py-1.5 text-sm text-zinc-500 hover:text-zinc-800">
            Cancel
          </button>
        </form>
      )}

      {actionError && <div className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{actionError}</div>}

      <div className="overflow-hidden rounded-md border border-zinc-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-200 bg-zinc-50 text-left text-xs text-zinc-500">
              <th className="py-2 pl-4 font-medium">Index</th>
              <th className="py-2 font-medium">Fields</th>
              <th className="py-2 font-medium">Kind</th>
              <th className="py-2 pr-4 text-right font-medium">Size</th>
              <th className="py-2 pr-4 text-right font-medium">Reads</th>
              <th className="w-24 py-2 pr-4" />
            </tr>
          </thead>
          <tbody>
            {data.indexes.map((index) => {
              const declared = data.declared.find((d) => d.name === index.name)
              return (
                <tr key={index.name} className="border-b border-zinc-100 last:border-0">
                  <td className="max-w-[320px] truncate py-2.5 pl-4 font-mono text-[13px] text-zinc-900" title={index.name}>{index.name}</td>
                  <td className="py-2.5 font-mono text-[13px] text-zinc-700">
                    {index.fields.join(', ')}
                    {index.method === 'gin' && <span className="text-zinc-400"> (GIN)</span>}
                  </td>
                  <td className="py-2.5">
                    <span className="rounded px-1.5 py-0.5 text-[11px] font-medium" style={{ background: KIND_STYLE[index.kind].bg, color: KIND_STYLE[index.kind].fg }}>
                      {index.valid ? index.kind : 'building'}
                    </span>
                  </td>
                  <td className="py-2.5 pr-4 text-right font-mono text-[13px] tabular-nums text-zinc-700">{bytes(index.sizeBytes)}</td>
                  <td className={`py-2.5 pr-4 text-right font-mono text-[13px] tabular-nums ${index.reads === 0 ? 'text-amber-600' : 'text-zinc-700'}`}>{num(index.reads)}</td>
                  <td className="py-2.5 pr-4 text-right">
                    {declared && data.writable && (
                      <button type="button" disabled={busy} onClick={() => remove(declared.name)} className="rounded border border-zinc-200 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-50">
                        Remove
                      </button>
                    )}
                    {index.kind === 'legacy' && (
                      <button type="button" disabled={busy} onClick={() => drop(index.name)} className="rounded border border-red-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50">
                        Drop
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
            {pending.map((d) => (
              <tr key={`pending-${d.name}`} className="border-b border-zinc-100 last:border-0">
                <td className="py-2.5 pl-4 font-mono text-[13px] text-zinc-500">{d.name}</td>
                <td className="py-2.5 font-mono text-[13px] text-zinc-500">{[...(d.equals ?? []), d.orderedBy].filter(Boolean).join(', ')}</td>
                <td className="py-2.5">
                  <span className="flex items-center gap-1 text-[11px] font-medium text-sky-700">
                    <Loader2 className="h-3 w-3 animate-spin" /> building
                  </span>
                </td>
                <td colSpan={3} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {data.suggested.length > 0 && (
        <>
          <h2 className="mb-2 mt-6 text-base font-semibold text-zinc-900">Suggested</h2>
          <div className="overflow-hidden rounded-md border border-zinc-200 bg-white">
            {data.suggested.map((s) => (
              <div key={describe(s.index)} className="flex items-center gap-4 border-b border-zinc-100 px-4 py-2.5 last:border-0">
                <span className="font-mono text-[13px] text-zinc-900">{`{ ${describe(s.index)} }`}</span>
                <span className="text-xs text-zinc-500">
                  {num(s.queries)} {s.queries === 1 ? 'query' : 'queries'} without an index · last {ago(s.lastSeen)} ago
                </span>
                <button
                  type="button"
                  disabled={!data.writable || busy}
                  onClick={() => declare(s.index)}
                  className="ml-auto rounded-md bg-sky-500 px-3 py-1 text-sm font-medium text-white hover:bg-sky-600 disabled:bg-zinc-300"
                >
                  Declare
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="mt-4 text-right text-xs text-zinc-500">
        Indexes {bytes(data.indexBytes)} · table {bytes(data.tableBytes)}
      </div>
    </div>
  )
}
