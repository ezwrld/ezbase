import { useState, useEffect, useCallback } from 'react'

export interface AuthUserRow {
  id: string
  email: string | null
  name: string | null
  role: string
  providers: string[]
  created: number | null
  lastLogin: number | null
}

export function useAuthUsers(adminKey: string) {
  const [users, setUsers] = useState<AuthUserRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/users?limit=200', {
        headers: { Authorization: `Bearer ${adminKey}` },
      })
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      const data = await res.json()
      setUsers(Array.isArray(data) ? data : [])
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load users')
    } finally {
      setLoading(false)
    }
  }, [adminKey])

  useEffect(() => {
    setLoading(true)
    refresh()
  }, [refresh])

  return { users, loading, error, refresh }
}
