import { useState, useEffect, useCallback } from 'react'

export function useCollections(database: string, adminKey: string) {
  const [collections, setCollections] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const basePath = database === 'default' ? '/api' : `/api/db/${encodeURIComponent(database)}`

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${basePath}/collections`, {
        headers: { Authorization: `Bearer ${adminKey}` },
      })
      if (!res.ok) throw new Error(`${res.status}`)
      const data: string[] = await res.json()
      setCollections(data)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch')
    } finally {
      setLoading(false)
    }
  }, [basePath, adminKey])

  useEffect(() => {
    setLoading(true)
    refresh()
    const interval = setInterval(refresh, 30_000)
    return () => clearInterval(interval)
  }, [refresh])

  return { collections, loading, error, refresh }
}
