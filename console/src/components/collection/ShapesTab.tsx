import { Fragment, useEffect, useState } from 'react'
import { AlertCircle, ChevronRight, Copy, Check, Loader2, X } from 'lucide-react'
import { api, dbBase, num, pct, TYPE_COLOR, type JsonType } from '@/lib/api'

type FieldShape = {
  path: string
  present: number
  types: Partial<Record<JsonType, number>>
  values?: { value: string; count: number }[]
}

type Issue = { path: string; kind: 'type-conflict' | 'null-and-missing'; detail: string; script: string }

type Shapes = {
  total: number
  sampled: number
  fields: FieldShape[]
  shapes: { keys: string[]; count: number }[]
  shapeCount: number
  groupedBy: string | null
  groups: { value: string; documents: number; shapes: number }[]
  issues: Issue[]
  typescript: string
}

const TYPE_ORDER: JsonType[] = ['string', 'number', 'boolean', 'object', 'array', 'null']

export function ShapesTab({ database, collection }: { database: string; collection: string }) {
  const [data, setData] = useState<Shapes | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [showIssues, setShowIssues] = useState(false)

  useEffect(() => {
    let alive = true
    setData(null)
    setError(null)
    setOpen(new Set())
    api<Shapes>(`${dbBase(database)}/collections/${encodeURIComponent(collection)}/shapes`)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(e.status === 404 && /Document not found/.test(e.message) ? 'Shapes need ezbase 1.17 or later on this instance' : e.message))
    return () => {
      alive = false
    }
  }, [database, collection])

  if (error) return <Notice icon={<AlertCircle className="h-4 w-4" />} text={error} tone="error" />
  if (!data) return <Notice icon={<Loader2 className="h-4 w-4 animate-spin" />} text={`Reading ${collection}`} />
  if (data.sampled === 0) return <Notice text="No documents" />

  const flagged = new Map(data.issues.map((i) => [i.path, i]))
  const toggle = (path: string) =>
    setOpen((prev) => {
      const next = new Set(prev)
      next.has(path) ? next.delete(path) : next.add(path)
      return next
    })

  const childrenOf = (prefix: string) =>
    data.fields.filter((f) => {
      if (!prefix) return !f.path.includes('.') && !f.path.includes('[]')
      if (!f.path.startsWith(prefix)) return false
      const rest = f.path.slice(prefix.length)
      return (rest.startsWith('.') && !rest.slice(1).includes('.') && !rest.includes('[]')) || rest === '[]'
    })

  const renderRows = (prefix: string, scope: number, depth: number): React.ReactNode =>
    childrenOf(prefix).map((field) => {
      const name = prefix ? field.path.slice(prefix.length + (field.path.startsWith(prefix + '.') ? 1 : 0)) || '[]' : field.path
      const kids = childrenOf(field.path)
      const expandable = kids.length > 0 || (field.values?.length ?? 0) > 1
      const isOpen = open.has(field.path)
      const issue = flagged.get(field.path)
      const objectCount = field.types.object ?? field.types.array ?? field.present
      return (
        <Fragment key={field.path}>
          <tr
            className={`border-b border-zinc-100 ${expandable ? 'cursor-pointer hover:bg-zinc-50' : ''}`}
            onClick={expandable ? () => toggle(field.path) : undefined}
          >
            <td className="py-2 pr-3" style={{ paddingLeft: 12 + depth * 18 }}>
              <div className="flex items-center gap-1.5 font-mono text-[13px] text-zinc-900">
                <ChevronRight
                  className={`h-3.5 w-3.5 shrink-0 text-zinc-400 transition-transform ${isOpen ? 'rotate-90' : ''} ${expandable ? '' : 'invisible'}`}
                />
                <span className="truncate" title={field.path}>{name}</span>
              </div>
            </td>
            <td className="py-2 pr-3">
              <div className="flex items-center gap-3">
                <TypeBar field={field} scope={scope} />
                <span className="w-14 shrink-0 font-mono text-xs text-zinc-500">{dominant(field)}</span>
                <span className="w-16 shrink-0">
                  {issue && (
                    <span
                      className="rounded px-1.5 py-0.5 text-[11px] font-medium"
                      style={{ background: '#fef3c7', color: '#b45309' }}
                      title={issue.detail}
                    >
                      {issue.kind === 'type-conflict' ? 'conflict' : 'mixed'}
                    </span>
                  )}
                </span>
              </div>
            </td>
            <td className="py-2 pr-4 text-right font-mono text-xs tabular-nums text-zinc-700">{pct(field.present, scope)}</td>
          </tr>
          {isOpen && kids.length === 0 && field.values && (
            <tr className="border-b border-zinc-100 bg-zinc-50/60">
              <td colSpan={3} className="py-2 pr-4" style={{ paddingLeft: 34 + depth * 18 }}>
                <div className="grid gap-1">
                  {field.values.map((v) => (
                    <div key={v.value} className="grid grid-cols-[180px_1fr_56px] items-center gap-3 text-xs">
                      <span className="truncate font-mono text-zinc-700" title={v.value}>{v.value}</span>
                      <span className="h-1.5 overflow-hidden rounded-full bg-zinc-200">
                        <span className="block h-full rounded-full" style={{ width: pct(v.count, field.present), background: TYPE_COLOR.string }} />
                      </span>
                      <span className="text-right font-mono tabular-nums text-zinc-600">{pct(v.count, field.present)}</span>
                    </div>
                  ))}
                </div>
              </td>
            </tr>
          )}
          {isOpen && kids.length > 0 && renderRows(field.path, objectCount, depth + 1)}
        </Fragment>
      )
    })

  const groupMax = Math.max(1, ...data.groups.map((g) => g.shapes))
  const shapeMax = Math.max(1, ...data.shapes.map((s) => s.count))

  return (
    <div className="flex-1 overflow-y-auto px-6 py-5">
      <div className="mb-4 flex items-end justify-between gap-4">
        <div>
          <h1 className="font-mono text-2xl font-semibold text-zinc-900">{collection}</h1>
          <div className="mt-1 flex gap-3 text-sm text-zinc-500">
            <span>{num(data.total)} documents</span>
            {data.sampled < data.total && <span className="border-l border-zinc-200 pl-3">sampled {num(data.sampled)}</span>}
          </div>
        </div>
        {data.issues.length > 0 && (
          <button
            type="button"
            onClick={() => setShowIssues(true)}
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-50"
          >
            Cleanup script
            <span className="ml-2 rounded bg-amber-100 px-1.5 text-xs text-amber-800">{data.issues.length}</span>
          </button>
        )}
      </div>

      <div className="grid grid-cols-[minmax(0,3fr)_minmax(320px,2fr)] items-start gap-5">
        <div className="overflow-hidden rounded-md border border-zinc-200 bg-white">
          <table className="w-full table-fixed text-sm">
            <colgroup>
              <col className="w-[34%]" />
              <col />
              <col className="w-[84px]" />
            </colgroup>
            <thead>
              <tr className="border-b border-zinc-200 bg-zinc-50 text-left text-xs font-medium text-zinc-500">
                <th className="py-2 pl-3 font-medium">Field</th>
                <th className="py-2 font-medium">Types</th>
                <th className="py-2 pr-4 text-right font-medium">Present</th>
              </tr>
            </thead>
            <tbody>{renderRows('', data.sampled, 0)}</tbody>
          </table>
        </div>

        <div className="grid gap-5">
          <CodePanel title="TypeScript" code={data.typescript} />

          {data.groupedBy && data.groups.length > 1 ? (
            <Panel title={`Shapes by ${data.groupedBy}`}>
              <div className="grid gap-2.5">
                {data.groups.map((g) => (
                  <div key={g.value} className="grid grid-cols-[minmax(0,140px)_1fr_28px] items-center gap-3 text-xs">
                    <span className="truncate font-mono text-zinc-800" title={`${num(g.documents)} documents`}>{g.value}</span>
                    <span className="h-2.5 overflow-hidden rounded-sm bg-zinc-100">
                      <span className="block h-full rounded-sm" style={{ width: `${(g.shapes / groupMax) * 100}%`, background: TYPE_COLOR.string }} />
                    </span>
                    <span className="text-right font-mono tabular-nums text-zinc-700">{g.shapes}</span>
                  </div>
                ))}
              </div>
            </Panel>
          ) : (
            <Panel title={data.shapeCount === 1 ? 'One shape' : `${num(data.shapeCount)} shapes`}>
              <div className="grid gap-2.5">
                {data.shapes.slice(0, 6).map((s, i) => (
                  <div key={i} className="grid grid-cols-[1fr_64px] items-center gap-3 text-xs">
                    <span className="h-2.5 overflow-hidden rounded-sm bg-zinc-100" title={s.keys.join(', ')}>
                      <span className="block h-full rounded-sm" style={{ width: `${(s.count / shapeMax) * 100}%`, background: TYPE_COLOR.object }} />
                    </span>
                    <span className="text-right font-mono tabular-nums text-zinc-700">{pct(s.count, data.sampled)}</span>
                  </div>
                ))}
              </div>
            </Panel>
          )}
        </div>
      </div>

      {showIssues && <IssuesDrawer issues={data.issues} onClose={() => setShowIssues(false)} />}
    </div>
  )
}

function dominant(field: FieldShape): string {
  const entries = Object.entries(field.types) as [JsonType, number][]
  entries.sort((a, b) => b[1] - a[1])
  return entries[0]?.[0] ?? ''
}

function TypeBar({ field, scope }: { field: FieldShape; scope: number }) {
  const segments = TYPE_ORDER.filter((t) => field.types[t]).map((t) => ({ type: t, count: field.types[t]! }))
  segments.sort((a, b) => b.count - a.count)
  return (
    <div
      className="flex h-[18px] min-w-0 flex-1 overflow-hidden rounded-sm"
      style={{ background: 'repeating-linear-gradient(135deg, #f4f4f5 0 4px, #e4e4e7 4px 5px)' }}
      title={[...segments.map((s) => `${s.type} ${num(s.count)}`), `missing ${num(scope - field.present)}`].join(' · ')}
    >
      {segments.map((s) => {
        const share = (s.count / scope) * 100
        return (
          <div
            key={s.type}
            className="flex h-full items-center justify-center overflow-hidden text-[10px] font-medium text-white"
            style={{ width: `${share}%`, background: TYPE_COLOR[s.type] }}
          >
            {share >= 12 && pct(s.count, scope)}
          </div>
        )
      })}
    </div>
  )
}

function Panel({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-md border border-zinc-200 bg-white">
      <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-2.5">
        <h2 className="text-sm font-semibold text-zinc-900">{title}</h2>
        {action}
      </div>
      <div className="p-4">{children}</div>
    </section>
  )
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(text)
        setDone(true)
        setTimeout(() => setDone(false), 1200)
      }}
      className="flex items-center gap-1 rounded border border-zinc-200 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-50"
    >
      {done ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
      {done ? 'Copied' : label}
    </button>
  )
}

export function CodePanel({ title, code }: { title: string; code: string }) {
  return (
    <Panel title={title} action={<CopyButton text={code} />}>
      <pre className="max-h-[560px] overflow-auto whitespace-pre-wrap break-words rounded bg-zinc-50 p-3 font-mono text-[12.5px] leading-relaxed text-zinc-800">
        <Highlighted code={code} />
      </pre>
    </Panel>
  )
}

/** Light TypeScript coloring: keywords, primitive types, string literals. */
function Highlighted({ code }: { code: string }) {
  const parts = code.split(/("[^"\n]*"|\b(?:interface|string|number|boolean|null|unknown|Record|Array|const|await|for|of|if|continue)\b)/g)
  return (
    <>
      {parts.map((part, i) => {
        if (/^"/.test(part)) return <span key={i} style={{ color: '#0f766e' }}>{part}</span>
        if (/^(interface|const|await|for|of|if|continue)$/.test(part)) return <span key={i} className="font-semibold text-zinc-500">{part}</span>
        if (/^(string|number|boolean|null|unknown|Record|Array)$/.test(part)) return <span key={i} style={{ color: TYPE_COLOR.string }}>{part}</span>
        return <Fragment key={i}>{part}</Fragment>
      })}
    </>
  )
}

function IssuesDrawer({ issues, onClose }: { issues: Issue[]; onClose: () => void }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-30 flex justify-end bg-zinc-900/20" onClick={onClose}>
      <aside className="h-full w-[640px] max-w-full overflow-y-auto border-l border-zinc-200 bg-white p-5" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-zinc-900">Cleanup scripts</h2>
          <button type="button" onClick={onClose} className="rounded p-1 text-zinc-500 hover:bg-zinc-100" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="grid gap-5">
          {issues.map((issue) => (
            <section key={issue.path}>
              <div className="mb-1.5 flex items-center gap-2">
                <span className="font-mono text-sm font-medium text-zinc-900">{issue.path}</span>
                <span className="rounded px-1.5 py-0.5 text-[11px] font-medium" style={{ background: '#fef3c7', color: '#b45309' }}>
                  {issue.kind === 'type-conflict' ? 'conflict' : 'mixed'}
                </span>
                <span className="ml-auto"><CopyButton text={issue.script} /></span>
              </div>
              <div className="mb-2 font-mono text-xs text-zinc-500">{issue.detail}</div>
              <pre className="whitespace-pre-wrap break-words rounded bg-zinc-50 p-3 font-mono text-[12px] leading-relaxed text-zinc-800">
                <Highlighted code={issue.script} />
              </pre>
            </section>
          ))}
        </div>
      </aside>
    </div>
  )
}

export function Notice({ icon, text, tone }: { icon?: React.ReactNode; text: string; tone?: 'error' }) {
  return (
    <div className={`flex flex-1 items-center justify-center gap-2 py-20 text-sm ${tone === 'error' ? 'text-red-600' : 'text-zinc-500'}`}>
      {icon}
      {text}
    </div>
  )
}
