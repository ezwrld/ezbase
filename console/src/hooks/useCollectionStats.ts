import { useState, useEffect, useRef } from 'react'

export interface CollectionStats {
  name: string
  count: number
  size: number // approximate bytes (JSON-encoded data)
}

export function useCollectionStats(collections: string[]) {
  const [stats, setStats] = useState<Map<string, CollectionStats>>(new Map())
  const sourcesRef = useRef<Map<string, EventSource>>(new Map())

  useEffect(() => {
    const sources = sourcesRef.current
    const currentNames = new Set(collections)

    // Close SSE for removed collections
    for (const [name, es] of sources) {
      if (!currentNames.has(name)) {
        es.close()
        sources.delete(name)
        setStats((prev) => {
          const next = new Map(prev)
          next.delete(name)
          return next
        })
      }
    }

    // Open SSE for new collections
    for (const name of collections) {
      if (sources.has(name)) continue

      const url = `/api/collections/${encodeURIComponent(name)}/sse`
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
  }, [collections.join(',')])  // eslint-disable-line react-hooks/exhaustive-deps

  return Array.from(stats.values())
}
