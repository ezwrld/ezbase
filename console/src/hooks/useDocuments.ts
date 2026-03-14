import { useState, useEffect, useCallback } from 'react'

export interface EzDocument {
  id: string
  data: Record<string, unknown>
  created: number
  updated: number
}

const PAGE_SIZE = 100

export function useDocuments(database: string, collection: string | null, adminKey: string) {
  const [documents, setDocuments] = useState<EzDocument[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(0)
  const [totalCount, setTotalCount] = useState(0)

  const basePath = database === 'default' ? '/api' : `/api/db/${encodeURIComponent(database)}`

  // Reset page when collection changes
  useEffect(() => {
    setPage(0)
  }, [collection])

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

    const offset = page * PAGE_SIZE
    const params = new URLSearchParams({
      token: adminKey,
      limit: String(PAGE_SIZE),
      offset: String(offset),
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
  }, [basePath, collection, adminKey, page])

  // Fetch total count separately for pagination controls
  useEffect(() => {
    if (!collection) {
      setTotalCount(0)
      return
    }

    const fetchCount = async () => {
      try {
        const res = await fetch(
          `${basePath}/collections/${encodeURIComponent(collection)}/stats`,
          { headers: { Authorization: `Bearer ${adminKey}` } }
        )
        if (res.ok) {
          const data = await res.json()
          setTotalCount(data.count)
        }
      } catch {}
    }

    fetchCount()
    const timer = setInterval(fetchCount, 5000)
    return () => clearInterval(timer)
  }, [basePath, collection, adminKey])

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE))

  // Clamp page when totalPages shrinks (e.g. after deletes)
  useEffect(() => {
    setPage((p) => (p >= totalPages ? Math.max(0, totalPages - 1) : p))
  }, [totalPages])

  const nextPage = useCallback(() => setPage((p) => Math.min(p + 1, totalPages - 1)), [totalPages])
  const prevPage = useCallback(() => setPage((p) => Math.max(p - 1, 0)), [])
  const goToPage = useCallback((n: number) => setPage(Math.max(0, Math.min(n, totalPages - 1))), [totalPages])

  return {
    documents,
    loading,
    error,
    page,
    totalPages,
    totalCount,
    pageSize: PAGE_SIZE,
    nextPage,
    prevPage,
    goToPage,
  }
}
