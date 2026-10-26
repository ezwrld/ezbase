import { useState, useEffect } from 'react'

export interface EzDocument {
  id: string
  data: Record<string, unknown>
  created: number
  updated: number
}

/** The table shows the newest documents; the header count comes from collection stats. */
const PAGE_SIZE = 100

export function useDocuments(database: string, collection: string | null, adminKey: string) {
  const [documents, setDocuments] = useState<EzDocument[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const basePath = database === 'default' ? '/api' : `/api/db/${encodeURIComponent(database)}`

  useEffect(() => {
    if (!collection) {
      setDocuments([])
      setLoading(false)
      setError(null)
      return
    }

    setLoading(true)
    setError(null)

    const params = new URLSearchParams({
      token: adminKey,
      limit: String(PAGE_SIZE),
    })
    const url = `${basePath}/collections/${encodeURIComponent(collection)}/sse?${params}`
    const es = new EventSource(url)

    es.addEventListener('snapshot', (e: MessageEvent) => {
      try {
        const docs: EzDocument[] = JSON.parse(e.data)
        setDocuments(docs)
        setError(null)
      } catch {
        setError('Failed to parse snapshot')
      } finally {
        setLoading(false)
      }
    })

    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) {
        setError('SSE connection closed')
        setLoading(false)
      }
    }

    return () => {
      es.close()
    }
  }, [basePath, collection, adminKey])

  return {
    documents,
    loading,
    error,
  }
}
