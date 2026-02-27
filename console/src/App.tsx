import { useState } from 'react'
import { Loader2, AlertCircle, Radio, Database, ChevronDown } from 'lucide-react'
import { useDatabases } from '@/hooks/useDatabases'
import { useCollections } from '@/hooks/useCollections'
import { useDocuments } from '@/hooks/useDocuments'
import { useCollectionStats } from '@/hooks/useCollectionStats'
import { DocumentTable } from '@/components/DocumentTable'
import { Dashboard } from '@/components/Dashboard'

export default function App() {
  const [selectedDb, setSelectedDb] = useState('default')
  const [selected, setSelected] = useState<string | null>(null)
  const [dbDropdownOpen, setDbDropdownOpen] = useState(false)
  const { databases, loading: dbLoading } = useDatabases()
  const { collections, loading: colLoading, error: colError, refresh } = useCollections(selectedDb)
  const { documents, loading: docLoading, error: docError } = useDocuments(selectedDb, selected)
  const stats = useCollectionStats(selectedDb, collections)
  const statsMap = new Map(stats.map((s) => [s.name, s]))

  function selectCollection(name: string) {
    setSelected(name)
    refresh()
  }

  function selectDatabase(name: string) {
    setSelectedDb(name)
    setSelected(null)
    setDbDropdownOpen(false)
  }

  return (
    <div className="flex h-screen flex-col">
      {/* Header */}
      <header className="flex h-12 shrink-0 items-center justify-between border-b-2 border-primary bg-zinc-950 px-5">
        <button onClick={() => setSelected(null)} className="font-mono text-sm font-medium tracking-tight">
          <span className="text-sky-400">ez</span>
          <span className="text-zinc-50">base</span>
          <span className="mx-0.5 font-normal text-zinc-600">/</span>
          <span className="font-normal text-zinc-600">console</span>
        </button>
      </header>

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <nav className="flex w-52 shrink-0 flex-col overflow-y-auto bg-zinc-900">
          {/* Database selector */}
          <div className="relative border-b border-zinc-800 px-3 py-3">
            <button
              onClick={() => setDbDropdownOpen(!dbDropdownOpen)}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-zinc-800"
            >
              <Database className="h-3.5 w-3.5 text-zinc-500" />
              <span className="flex-1 truncate text-left font-mono">{selectedDb}</span>
              <ChevronDown className={`h-3 w-3 text-zinc-500 transition-transform ${dbDropdownOpen ? 'rotate-180' : ''}`} />
            </button>

            {dbDropdownOpen && (
              <div className="absolute left-3 right-3 top-full z-10 mt-1 rounded border border-zinc-700 bg-zinc-800 py-1 shadow-lg">
                {dbLoading && (
                  <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-zinc-500">
                    <Loader2 className="h-3 w-3 animate-spin" /> Loading...
                  </div>
                )}
                {databases.map((db) => (
                  <button
                    key={db}
                    onClick={() => selectDatabase(db)}
                    className={`flex w-full items-center px-3 py-1.5 text-left font-mono text-xs transition-colors ${
                      selectedDb === db
                        ? 'bg-sky-400/10 text-sky-400'
                        : 'text-zinc-300 hover:bg-zinc-700'
                    }`}
                  >
                    {db}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="px-4 pb-2.5 pt-4 text-[10px] font-semibold uppercase tracking-widest text-zinc-600">
            Collections
          </div>

          {colLoading && (
            <div className="flex items-center gap-2 px-4 py-2 text-xs text-zinc-500">
              <Loader2 className="h-3 w-3 animate-spin" /> Loading...
            </div>
          )}

          {colError && (
            <div className="flex items-center gap-2 px-4 py-2 text-xs text-red-400">
              <AlertCircle className="h-3 w-3" /> {colError}
            </div>
          )}

          {!colLoading && !colError && collections.length === 0 && (
            <div className="px-4 py-2 text-xs text-zinc-500">
              No collections yet
            </div>
          )}

          {collections.map((name) => (
            <button
              key={name}
              onClick={() => selectCollection(name)}
              className={`flex items-center justify-between px-4 py-1.5 text-left font-mono text-xs transition-colors ${
                selected === name
                  ? 'border-l-2 border-sky-400 bg-sky-400/10 text-zinc-100'
                  : 'border-l-2 border-transparent text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'
              }`}
            >
              <span className="truncate">{name}</span>
              {statsMap.has(name) && (
                <span className="ml-2 shrink-0 rounded bg-zinc-700 px-1.5 py-0.5 text-[10px] font-medium text-zinc-300">
                  {statsMap.get(name)!.count}
                </span>
              )}
            </button>
          ))}
        </nav>

        {/* Main content */}
        <main className="flex flex-1 flex-col overflow-hidden bg-zinc-50">
          {!selected && (
            <Dashboard stats={stats} onSelectCollection={selectCollection} />
          )}

          {selected && (
            <>
              {/* Collection header */}
              <div className="flex items-center justify-between border-b border-zinc-200 bg-white px-5 py-3">
                <div className="flex items-center gap-3">
                  <h2 className="font-mono text-base font-semibold text-zinc-900">{selected}</h2>
                  {!docLoading && (
                    <span className="text-xs text-zinc-500">
                      {documents.length} document{documents.length !== 1 ? 's' : ''}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 text-xs text-emerald-600">
                  <Radio className="h-3 w-3" />
                  Live
                </div>
              </div>

              {/* Documents */}
              <div className="flex-1 overflow-auto">
                {docLoading && (
                  <div className="flex items-center justify-center py-20">
                    <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />
                  </div>
                )}

                {docError && (
                  <div className="flex items-center justify-center gap-2 py-20 text-sm text-red-500">
                    <AlertCircle className="h-4 w-4" /> {docError}
                  </div>
                )}

                {!docLoading && !docError && documents.length === 0 && (
                  <div className="flex items-center justify-center py-20 text-sm text-zinc-400">
                    Collection is empty
                  </div>
                )}

                {!docLoading && !docError && documents.length > 0 && (
                  <DocumentTable documents={documents} />
                )}
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  )
}
