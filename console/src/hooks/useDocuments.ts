import { useState, useEffect } from 'react'

export interface EzDocument {
  id: string
  data: Record<string, unknown>
  created: number
  updated: number
}

export function useDocuments(database: string, collection: string | null) {
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

    const url = `${basePath}/collections/${encodeURIComponent(collection)}/sse`
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
  }, [basePath, collection])

  return { documents, loading, error }
}
