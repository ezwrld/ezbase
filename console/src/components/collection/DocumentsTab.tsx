import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertCircle, Check, ChevronRight, Copy, Loader2, Pencil, Radio, Trash2 } from 'lucide-react'
import { useDocuments, type EzDocument } from '@/hooks/useDocuments'
import { ago, api, ApiError, dbBase, num, TYPE_COLOR, typeOf } from '@/lib/api'
import { Notice } from './ShapesTab'

export function cellText(value: unknown): string {
  if (value === undefined) return ''
  if (value === null) return 'null'
  if (Array.isArray(value)) return `[${value.length}]`
  if (typeof value === 'object') return `{${Object.keys(value).length}}`
  return String(value)
}

type Props = { database: string; collection: string; docId: string | null; total: number | null }

export function DocumentsTab({ database, collection, docId, total }: Props) {
  const navigate = useNavigate()
  const { documents, loading, error } = useDocuments(database, collection, localStorage.getItem('ezbase_admin_key') || '')
  const base = `/data/${encodeURIComponent(database)}/${encodeURIComponent(collection)}/documents`

  const columns = useMemo(() => {
    const counts = new Map<string, number>()
    for (const doc of documents) {
      for (const [key, value] of Object.entries(doc.data)) {
        if (key === 'id' || (value !== null && typeof value === 'object')) continue
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
    }
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, docId ? 3 : 5).map(([k]) => k)
  }, [documents, docId])

  const listed = docId ? documents.find((d) => d.id === docId) ?? null : null

  return (
    <div className="flex min-h-0 flex-1">
      <div className={`flex min-w-0 flex-col ${docId ? 'w-[55%] border-r border-zinc-200' : 'flex-1'}`}>
        <div className="flex items-center justify-between px-6 py-3 text-sm">
          <span className="font-medium text-zinc-900">{total !== null ? `${num(total)} documents` : ' '}</span>
          <span className="flex items-center gap-1.5 text-xs text-emerald-600">
            <Radio className="h-3 w-3" /> Live · newest {Math.min(documents.length, 100)}
          </span>
        </div>
        {loading && <Notice icon={<Loader2 className="h-4 w-4 animate-spin" />} text="Loading documents" />}
        {error && <Notice icon={<AlertCircle className="h-4 w-4" />} text={error} tone="error" />}
        {!loading && !error && documents.length === 0 && <Notice text="No documents" />}
        {!loading && !error && documents.length > 0 && (
          <div className="min-h-0 flex-1 overflow-auto px-6 pb-6">
            <table className="w-full table-fixed rounded-md border border-zinc-200 bg-white text-sm">
              <colgroup>
                <col className="w-[28%]" />
                {columns.map((c) => <col key={c} />)}
                <col className="w-[72px]" />
              </colgroup>
              <thead className="sticky top-0 z-10">
                <tr className="border-b border-zinc-200 bg-zinc-50 text-left text-xs text-zinc-500">
                  <th className="py-2 pl-4 font-medium">id</th>
                  {columns.map((c) => <th key={c} className="truncate py-2 pr-3 font-medium">{c}</th>)}
                  <th className="py-2 pr-4 text-right font-medium">updated</th>
                </tr>
              </thead>
              <tbody>
                {documents.map((doc) => (
                  <tr
                    key={doc.id}
                    onClick={() => navigate(`${base}/${encodeURIComponent(doc.id)}`)}
                    className={`cursor-pointer border-b border-zinc-100 last:border-0 ${doc.id === docId ? 'bg-sky-50' : 'hover:bg-zinc-50'}`}
                  >
                    <td className="truncate py-2 pl-4 font-mono text-[13px] text-zinc-900" title={doc.id}>{doc.id}</td>
                    {columns.map((c) => (
                      <td key={c} className="truncate py-2 pr-3 font-mono text-[13px] text-zinc-700" title={cellText(doc.data[c])}>{cellText(doc.data[c])}</td>
                    ))}
                    <td className="py-2 pr-4 text-right font-mono text-[13px] tabular-nums text-zinc-500">{ago(doc.updated)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {docId && (
        <DocumentPanel
          key={`${database}/${collection}/${docId}`}
          database={database}
          collection={collection}
          id={docId}
          listed={listed}
          onDeleted={() => navigate(base)}
        />
      )}
    </div>
  )
}

function DocumentPanel({ database, collection, id, listed, onDeleted }: { database: string; collection: string; id: string; listed: EzDocument | null; onDeleted: () => void }) {
  const url = `${dbBase(database)}/collections/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`
  const [fetched, setFetched] = useState<EzDocument | null>(null)
  const [missing, setMissing] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (listed) return
    api<EzDocument>(url)
      .then(setFetched)
      .catch((e) => (e instanceof ApiError && e.status === 404 ? setMissing(true) : setError(e.message)))
  }, [url, listed])

  const doc = listed ?? fetched
  if (missing) return <Side><Notice text={`No document ${id}`} /></Side>
  if (!doc) return <Side><Notice icon={error ? <AlertCircle className="h-4 w-4" /> : <Loader2 className="h-4 w-4 animate-spin" />} text={error ?? 'Loading'} tone={error ? 'error' : undefined} /></Side>

  const save = async () => {
    if (editing === null) return
    let data: unknown
    try {
      data = JSON.parse(editing)
    } catch (e) {
      setError(`Invalid JSON: ${(e as Error).message}`)
      return
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      setError('A document is a JSON object')
      return
    }
    setBusy(true)
    setError(null)
    try {
      setFetched(await api<EzDocument>(url, { method: 'PUT', body: JSON.stringify(data) }))
      setEditing(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!window.confirm(`Delete ${id} from ${collection}?`)) return
    setBusy(true)
    try {
      await api(url, { method: 'DELETE' })
      onDeleted()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <Side>
      <div className="flex items-start justify-between gap-3 border-b border-zinc-100 px-5 py-4">
        <h2 className="min-w-0 break-all font-mono text-lg font-semibold text-zinc-900">{doc.id}</h2>
        <div className="flex shrink-0 gap-2">
          <IconButton
            onClick={() => {
              navigator.clipboard.writeText(JSON.stringify(doc.data, null, 2))
              setCopied(true)
              setTimeout(() => setCopied(false), 1200)
            }}
            icon={copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
            label={copied ? 'Copied' : 'Copy'}
          />
          <IconButton onClick={() => setEditing(JSON.stringify(doc.data, null, 2))} icon={<Pencil className="h-3.5 w-3.5" />} label="Edit" />
          <IconButton onClick={remove} icon={<Trash2 className="h-3.5 w-3.5" />} label="Delete" danger disabled={busy} />
        </div>
      </div>
      {error && <div className="mx-5 mt-3 rounded bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      {editing !== null ? (
        <div className="flex min-h-0 flex-1 flex-col gap-3 p-5">
          <textarea
            value={editing}
            onChange={(e) => setEditing(e.target.value)}
            spellCheck={false}
            className="min-h-0 flex-1 resize-none rounded border border-zinc-300 p-3 font-mono text-[12.5px] leading-relaxed outline-none focus:border-sky-500"
          />
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => { setEditing(null); setError(null) }} className="px-3 py-1.5 text-sm text-zinc-600 hover:text-zinc-900">Cancel</button>
            <button type="button" onClick={save} disabled={busy} className="rounded-md bg-sky-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-600 disabled:opacity-60">Save</button>
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
          <div className="overflow-hidden rounded-md border border-zinc-200">
            {Object.entries(doc.data).map(([key, value]) => <FieldRow key={key} name={key} value={value} depth={0} />)}
          </div>
          <div className="mt-3 text-xs text-zinc-500">
            created {new Date(doc.created).toLocaleString()} · updated {ago(doc.updated)} ago
          </div>
        </div>
      )}
    </Side>
  )
}

function Side({ children }: { children: React.ReactNode }) {
  return <div className="flex w-[45%] min-w-0 flex-col bg-white">{children}</div>
}

function IconButton({ onClick, icon, label, danger, disabled }: { onClick: () => void; icon: React.ReactNode; label: string; danger?: boolean; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium disabled:opacity-50 ${
        danger ? 'border-red-200 text-red-600 hover:bg-red-50' : 'border-zinc-200 text-zinc-700 hover:bg-zinc-50'
      }`}
    >
      {icon} {label}
    </button>
  )
}

function FieldRow({ name, value, depth }: { name: string; value: unknown; depth: number }) {
  const [open, setOpen] = useState(false)
  const type = typeOf(value)
  const nested = (type === 'object' || type === 'array') && value !== null && Object.keys(value as object).length > 0
  const entries = nested ? Object.entries(value as object) : []
  return (
    <>
      <div
        onClick={nested ? () => setOpen(!open) : undefined}
        className={`grid grid-cols-[minmax(0,180px)_80px_minmax(0,1fr)] items-start gap-3 border-b border-zinc-100 py-1.5 pr-3 text-[13px] last:border-0 ${nested ? 'cursor-pointer hover:bg-zinc-50' : ''}`}
        style={{ paddingLeft: 12 + depth * 16 }}
      >
        <span className="flex min-w-0 items-center gap-1 font-mono text-zinc-900">
          <ChevronRight className={`h-3 w-3 shrink-0 text-zinc-400 transition-transform ${open ? 'rotate-90' : ''} ${nested ? '' : 'invisible'}`} />
          <span className="truncate" title={name}>{name}</span>
        </span>
        <span className="flex items-center gap-1.5 text-xs text-zinc-500">
          <span className="h-2 w-2 rounded-full" style={{ background: TYPE_COLOR[type] }} />
          {type}
        </span>
        <span className="break-words font-mono text-zinc-800 [overflow-wrap:anywhere]">
          {type === 'string' ? (value as string) : cellText(value)}
        </span>
      </div>
      {open && entries.map(([k, v]) => <FieldRow key={k} name={k} value={v} depth={depth + 1} />)}
    </>
  )
}
