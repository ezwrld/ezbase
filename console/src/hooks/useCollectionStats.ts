import { useState, useEffect, useRef } from 'react'

export interface CollectionStats {
  name: string
  count: number
  size: number
}

export function useCollectionStats(database: string, collections: string[], adminKey: string) {
  const [stats, setStats] = useState<Map<string, CollectionStats>>(new Map())
  const timerRef = useRef<ReturnType<typeof setInterval>>()

  const basePath = database === 'default' ? '/api' : `/api/db/${encodeURIComponent(database)}`

  useEffect(() => {
    setStats(new Map())
    if (!collections.length || !adminKey) return

    const fetchStats = async () => {
      const results = await Promise.allSettled(
        collections.map(async (name) => {
          const res = await fetch(
            `${basePath}/collections/${encodeURIComponent(name)}/stats`,
            { headers: { Authorization: `Bearer ${adminKey}` } }
          )
          if (!res.ok) return null
          const data = await res.json()
          return { name, count: data.count as number, size: data.size as number }
        })
      )

      setStats((prev) => {
        const next = new Map(prev)
        for (const result of results) {
          if (result.status === 'fulfilled' && result.value) {
            next.set(result.value.name, result.value)
          }
        }
        return next
      })
    }

    fetchStats()
    timerRef.current = setInterval(fetchStats, 5000)

    return () => clearInterval(timerRef.current)
  }, [basePath, adminKey, collections.join(',')])  // eslint-disable-line react-hooks/exhaustive-deps

  return Array.from(stats.values())
}
