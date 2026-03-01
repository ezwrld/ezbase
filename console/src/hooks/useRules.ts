import { useState, useEffect, useCallback } from 'react'

interface RulesData {
  rules: Record<string, unknown>
  readonly: boolean
}

export function useRules(adminKey: string) {
  const [data, setData] = useState<RulesData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/rules', {
        headers: { Authorization: `Bearer ${adminKey}` },
      })
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      const json = await res.json()
      setData(json)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch rules')
    } finally {
      setLoading(false)
    }
  }, [adminKey])

  useEffect(() => {
    setLoading(true)
    refresh()
  }, [refresh])

  const save = useCallback(
    async (rules: Record<string, unknown>) => {
      const res = await fetch('/api/rules', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminKey}`,
        },
        body: JSON.stringify(rules),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }))
        throw new Error(body.error || res.statusText)
      }
      const json = await res.json()
      setData(json)
      return json
    },
    [adminKey]
  )

  return { data, loading, error, refresh, save }
}
