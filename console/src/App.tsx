import { useEffect, useRef, useState } from 'react'
import { Navigate, NavLink, Route, Routes, useMatch, useNavigate, useParams } from 'react-router-dom'
import { Loader2, AlertCircle, ChevronDown, FileJson, HardDrive, Activity as ActivityIcon, KeyRound, LogOut } from 'lucide-react'
import { useDatabases } from '@/hooks/useDatabases'
import { useCollections } from '@/hooks/useCollections'
import { useCollectionStats } from '@/hooks/useCollectionStats'
import { Dashboard } from '@/components/Dashboard'
import { RulesEditor } from '@/components/RulesEditor'
import { StorageBrowser } from '@/components/StorageBrowser'
import { Activity } from '@/components/Activity'
import { AuthSettings } from '@/components/AuthSettings'
import { DocumentsTab } from '@/components/collection/DocumentsTab'
import { QueryTab } from '@/components/collection/QueryTab'
import { IndexesTab } from '@/components/collection/IndexesTab'
import { ShapesTab } from '@/components/collection/ShapesTab'
import { ADMIN_KEY_STORAGE, num } from '@/lib/api'

const TABS = [
  { id: 'documents', label: 'Documents' },
  { id: 'query', label: 'Query' },
  { id: 'indexes', label: 'Indexes' },
  { id: 'shapes', label: 'Shapes' },
] as const
type TabId = (typeof TABS)[number]['id']

const PAGES: Record<string, string> = { auth: 'Auth', storage: 'Storage', rules: 'Rules', activity: 'Activity' }

/** Behind `ez fleet` each instance is `<name>.ezbase.localhost`; elsewhere the host names it. */
const INSTANCE = location.hostname.match(/^([^.]+)\.ezbase\.localhost$/)?.[1] ?? location.host

const dataPath = (db: string, collection: string, tab: TabId = 'documents', doc?: string) =>
  `/data/${encodeURIComponent(db)}/${encodeURIComponent(collection)}/${tab}${doc ? `/${encodeURIComponent(doc)}` : ''}`

export default function App() {
  const navigate = useNavigate()
  const dataMatch = useMatch('/data/:db/:collection/:tab/*')
  const pageMatch = useMatch('/:page')

  const [adminKey, setAdminKey] = useState<string | null>(() => localStorage.getItem(ADMIN_KEY_STORAGE))
  const [keyInput, setKeyInput] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [connectError, setConnectError] = useState<string | null>(null)
  const [chosenDb, setChosenDb] = useState('default')
  const [dbOpen, setDbOpen] = useState(false)
  const [version, setVersion] = useState('')

  const db = dataMatch?.params.db ?? chosenDb
  const collection = dataMatch?.params.collection ?? null
  const tab = (dataMatch?.params.tab as TabId | undefined) ?? 'documents'

  const { databases, loading: dbLoading } = useDatabases(adminKey || '')
  const { collections, loading: colLoading, error: colError } = useCollections(db, adminKey || '')
  const stats = useCollectionStats(db, collections, adminKey || '')
  const statsMap = new Map(stats.map((s) => [s.name, s]))

  useEffect(() => {
    fetch('/api/health').then((r) => r.json()).then((h) => setVersion(h.version ?? '')).catch(() => {})
  }, [])

  async function handleKeySubmit(e: React.FormEvent) {
    e.preventDefault()
    const key = keyInput.trim()
    if (!key) return
    setConnecting(true)
    setConnectError(null)
    try {
      const res = await fetch('/api/rules', { headers: { Authorization: `Bearer ${key}` } })
      if (!res.ok) throw new Error('Invalid admin key')
      localStorage.setItem(ADMIN_KEY_STORAGE, key)
      setAdminKey(key)
    } catch {
      setConnectError('Invalid admin key')
    } finally {
      setConnecting(false)
    }
  }

  function handleLogout() {
    localStorage.removeItem(ADMIN_KEY_STORAGE)
    setAdminKey(null)
    setKeyInput('')
  }

  function selectDatabase(name: string) {
    setChosenDb(name)
    setDbOpen(false)
    navigate('/')
  }

  if (!adminKey) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-[#0b0b0c] px-4">
        <form onSubmit={handleKeySubmit} className="w-full max-w-sm space-y-6">
          <div className="text-center text-2xl font-semibold tracking-tight">
            <span className="text-sky-500">ez</span>
            <span className="text-white">base</span>
          </div>
          <div>
            <label htmlFor="admin-key" className="mb-1.5 block text-xs font-medium text-zinc-400">Admin key</label>
            <input
              id="admin-key"
              type="password"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              autoFocus
              className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-sm text-zinc-100 outline-none focus:border-sky-500"
            />
            {connectError && <p className="mt-2 text-xs text-red-400">{connectError}</p>}
          </div>
          <button type="submit" disabled={connecting} className="flex w-full items-center justify-center gap-2 rounded-md bg-sky-500 px-3 py-2 text-sm font-medium text-white hover:bg-sky-600 disabled:opacity-50">
            {connecting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Connect
          </button>
        </form>
      </div>
    )
  }

  const page = pageMatch ? PAGES[pageMatch.params.page ?? ''] : undefined
  const segments: { label: string; to?: string }[] = [{ label: INSTANCE, to: '/' }]
  if (collection) {
    segments.push({ label: db, to: '/' }, { label: collection, to: dataPath(db, collection, tab) })
    const docId = dataMatch?.params['*']
    if (tab === 'documents' && docId) segments.push({ label: decodeURIComponent(docId) })
  } else if (page) {
    segments.push({ label: page })
  } else {
    segments.push({ label: db })
  }

  return (
    <div className="flex h-screen">
      <nav className="flex w-[232px] shrink-0 flex-col bg-[#0b0b0c] text-zinc-300">
        <NavLink to="/" className="px-5 pb-5 pt-5 text-[22px] font-bold tracking-tight">
          <span className="text-sky-500">ez</span>
          <span className="text-white">base</span>
        </NavLink>

        <div className="relative px-4">
          <button
            type="button"
            onClick={() => setDbOpen(!dbOpen)}
            className="flex w-full items-center justify-between rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-100 hover:border-zinc-500"
          >
            <span className="truncate">{db}</span>
            <ChevronDown className={`h-4 w-4 text-zinc-400 transition-transform ${dbOpen ? 'rotate-180' : ''}`} />
          </button>
          {dbOpen && (
            <div className="absolute left-4 right-4 top-full z-20 mt-1 rounded-md border border-zinc-700 bg-zinc-900 py-1">
              {dbLoading && <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-zinc-500"><Loader2 className="h-3 w-3 animate-spin" /> Loading</div>}
              {databases.map((name) => (
                <button
                  type="button"
                  key={name}
                  onClick={() => selectDatabase(name)}
                  className={`block w-full px-3 py-1.5 text-left text-sm ${name === db ? 'text-sky-400' : 'text-zinc-300 hover:bg-zinc-800'}`}
                >
                  {name}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="mt-5 px-5 pb-2 text-xs font-medium text-zinc-500">Collections</div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {colLoading && <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-zinc-500"><Loader2 className="h-3 w-3 animate-spin" /> Loading</div>}
          {colError && <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-red-400"><AlertCircle className="h-3 w-3" /> {colError}</div>}
          {!colLoading && !colError && collections.length === 0 && <div className="px-3 py-1.5 text-xs text-zinc-500">No collections</div>}
          {collections.map((name) => {
            const count = statsMap.get(name)?.count
            return (
              <button
                type="button"
                key={name}
                onClick={() => navigate(dataPath(db, name, tab))}
                className={`flex w-full items-center justify-between gap-2 rounded-md px-3 py-1.5 text-left font-mono text-[13px] ${
                  name === collection ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100'
                }`}
              >
                <span className="truncate" title={name}>{name}</span>
                {count !== undefined && <span className="shrink-0 tabular-nums text-zinc-500">{num(count)}</span>}
              </button>
            )
          })}
        </div>

        <div className="border-t border-zinc-800 px-2 py-3">
          {[
            { to: '/auth', label: 'Auth', icon: KeyRound },
            { to: '/storage', label: 'Storage', icon: HardDrive },
            { to: '/rules', label: 'Rules', icon: FileJson },
            { to: '/activity', label: 'Activity', icon: ActivityIcon },
          ].map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `flex items-center gap-2.5 rounded-md px-3 py-1.5 text-sm ${isActive ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100'}`
              }
            >
              <Icon className="h-4 w-4" /> {label}
            </NavLink>
          ))}
          <button type="button" onClick={handleLogout} className="flex w-full items-center gap-2.5 rounded-md px-3 py-1.5 text-sm text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200">
            <LogOut className="h-4 w-4" /> Log out
          </button>
        </div>
      </nav>

      <main className="flex min-w-0 flex-1 flex-col bg-zinc-50">
        <div className="shrink-0 bg-white px-6 pt-4">
          <PathBar
            segments={segments}
            version={version}
            onGo={(path) => {
              const parts = path.split('/').map((p) => p.trim()).filter(Boolean)
              const target = parts.length > 1 && databases.includes(parts[0] ?? '') ? parts.shift()! : db
              const [name, ...rest] = parts
              navigate(name ? dataPath(target, name, 'documents', rest.join('/') || undefined) : '/')
            }}
            current={collection ? [db, collection, tab === 'documents' ? dataMatch?.params['*'] && decodeURIComponent(dataMatch.params['*']) : ''].filter(Boolean).join('/') : ''}
          />
          {collection && (
            <div className="mt-3 flex gap-1 border-b border-zinc-200">
              {TABS.map((t) => (
                <NavLink
                  key={t.id}
                  to={dataPath(db, collection, t.id)}
                  className={`-mb-px border-b-2 px-3 pb-2.5 pt-1 text-sm ${
                    t.id === tab ? 'border-sky-500 font-medium text-zinc-900' : 'border-transparent text-zinc-500 hover:text-zinc-800'
                  }`}
                >
                  {t.label}
                </NavLink>
              ))}
            </div>
          )}
          {!collection && <div className="mt-3 border-b border-zinc-200" />}
        </div>

        <Routes>
          <Route path="/" element={<Dashboard stats={stats} onSelectCollection={(name) => navigate(dataPath(db, name))} />} />
          <Route path="/auth" element={<AuthSettings adminKey={adminKey} />} />
          <Route path="/activity" element={<Activity adminKey={adminKey} />} />
          <Route path="/rules" element={<RulesEditor adminKey={adminKey} />} />
          <Route path="/storage" element={<StorageBrowser adminKey={adminKey} />} />
          <Route path="/collections/:name" element={<LegacyCollection />} />
          <Route path="/data/:db/:collection" element={<CollectionRedirect />} />
          <Route
            path="/data/:db/:collection/:tab/*"
            element={<CollectionView total={collection ? statsMap.get(collection)?.count ?? null : null} />}
          />
        </Routes>
      </main>
    </div>
  )
}

function CollectionView({ total }: { total: number | null }) {
  const { db, collection, tab, '*': doc } = useParams()
  if (!db || !collection) return null
  if (tab === 'query') return <QueryTab database={db} collection={collection} />
  if (tab === 'indexes') return <IndexesTab database={db} collection={collection} />
  if (tab === 'shapes') return <ShapesTab database={db} collection={collection} />
  return <DocumentsTab database={db} collection={collection} docId={doc ? decodeURIComponent(doc) : null} total={total} />
}

function CollectionRedirect() {
  const { db, collection } = useParams()
  return <Navigate to={dataPath(db!, collection!)} replace />
}

function LegacyCollection() {
  const { name } = useParams()
  return <Navigate to={dataPath('default', name!)} replace />
}

/** Firebase-style path: clickable segments; click the bar to type `collection/doc` or `database/collection/doc`. */
function PathBar({ segments, version, current, onGo }: { segments: { label: string; to?: string }[]; version: string; current: string; onGo: (path: string) => void }) {
  const navigate = useNavigate()
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) input.current?.select()
  }, [editing])

  return (
    <div
      className="flex h-11 items-center rounded-md border border-zinc-200 bg-zinc-50 px-3 text-sm"
      onClick={() => {
        if (!editing) {
          setText(current)
          setEditing(true)
        }
      }}
    >
      {editing ? (
        <input
          ref={input}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setEditing(false)
            if (e.key === 'Enter') {
              setEditing(false)
              onGo(text)
            }
          }}
          placeholder="collection/document"
          className="min-w-0 flex-1 bg-transparent font-mono text-sm text-zinc-900 outline-none"
        />
      ) : (
        <div className="flex min-w-0 flex-1 cursor-text items-center gap-2 font-mono">
          {segments.map((s, i) => (
            <span key={i} className="flex min-w-0 items-center gap-2">
              {i > 0 && <span className="text-zinc-400">›</span>}
              {s.to && i < segments.length - 1 ? (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    navigate(s.to!)
                  }}
                  className="truncate text-sky-600 hover:underline"
                >
                  {s.label}
                </button>
              ) : (
                <span className="truncate text-zinc-900" title={s.label}>{s.label}</span>
              )}
            </span>
          ))}
        </div>
      )}
      {version && <span className="ml-3 shrink-0 font-mono text-xs text-zinc-400">{version}</span>}
    </div>
  )
}
