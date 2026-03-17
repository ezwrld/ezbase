import { useState, useEffect } from 'react'

export interface EzDocument {
  id: string
  data: Record<string, unknown>
  created: number
  updated: number
}

export function useDocuments(database: string, collection: string | null, adminKey: string) {
  const [documents, setDocuments] = useState<EzDocument[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [totalCount, setTotalCount] = useState(0)

  const basePath = database === 'default' ? '/api' : `/api/db/${encodeURIComponent(database)}`

  useEffect(() => {
    if (!collection) {
      setDocuments([])
      setLoading(false)
      setError(null)
      setTotalCount(0)
      return
    }

    setLoading(true)
    setError(null)

    const params = new URLSearchParams({
      token: adminKey,
    })
    const url = `${basePath}/collections/${encodeURIComponent(collection)}/sse?${params}`
    const es = new EventSource(url)

    es.addEventListener('snapshot', (e: MessageEvent) => {
      try {
        const docs: EzDocument[] = JSON.parse(e.data)
        setDocuments(docs)
        setTotalCount(docs.length)
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
    totalCount,
  }
}
