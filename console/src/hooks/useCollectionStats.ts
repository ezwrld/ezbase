import { useState, useEffect, useRef } from 'react'

export interface CollectionStats {
  name: string
  count: number
  size: number // approximate bytes (JSON-encoded data)
}

export function useCollectionStats(database: string, collections: string[]) {
  const [stats, setStats] = useState<Map<string, CollectionStats>>(new Map())
  const sourcesRef = useRef<Map<string, EventSource>>(new Map())

  const basePath = database === 'default' ? '/api' : `/api/db/${encodeURIComponent(database)}`

  useEffect(() => {
    const sources = sourcesRef.current

    // Close all existing SSE connections on database or collections change
    for (const es of sources.values()) {
      es.close()
    }
    sources.clear()
    setStats(new Map())

    // Open SSE for each collection
    for (const name of collections) {
      const url = `${basePath}/collections/${encodeURIComponent(name)}/sse`
      const es = new EventSource(url)
      sources.set(name, es)

      es.addEventListener('snapshot', (e: MessageEvent) => {
        try {
          const docs: { id: string; data: Record<string, unknown> }[] = JSON.parse(e.data)
          const count = docs.length
          let size = 0
          for (const doc of docs) {
            size += new Blob([JSON.stringify(doc.data)]).size
          }
          setStats((prev) => {
            const next = new Map(prev)
            next.set(name, { name, count, size })
            return next
          })
        } catch {
          // ignore parse errors
        }
      })
    }

    return () => {
      for (const es of sources.values()) {
        es.close()
      }
      sources.clear()
    }
  }, [basePath, collections.join(',')])  // eslint-disable-line react-hooks/exhaustive-deps

  return Array.from(stats.values())
}
