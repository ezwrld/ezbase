import { useState, useEffect, useCallback } from 'react'

export type ProviderId = 'google' | 'github' | 'microsoft' | 'apple'

export interface ProviderView {
  enabled: boolean
  clientId: string
  clientSecretSet: boolean
}

export interface AuthSettings {
  publicUrl: string
  extraOrigins: string[]
  callbackBase: string
  providers: Record<ProviderId, ProviderView>
  emailPassword: true
  readonly: boolean
}

export function useAuthSettings(adminKey: string) {
  const [data, setData] = useState<AuthSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/settings', {
        headers: { Authorization: `Bearer ${adminKey}` },
      })
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      setData(await res.json())
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load auth settings')
    } finally {
      setLoading(false)
    }
  }, [adminKey])

  useEffect(() => {
    setLoading(true)
    refresh()
  }, [refresh])

  const save = useCallback(
    async (body: {
      publicUrl: string
      extraOrigins: string[]
      providers: Partial<Record<ProviderId, { enabled: boolean; clientId: string; clientSecret?: string } | null>>
    }) => {
      const res = await fetch('/api/auth/settings', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminKey}`,
        },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const json = await res.json().catch(() => ({ error: res.statusText }))
        throw new Error(json.error || res.statusText)
      }
      const json = await res.json()
      setData(json)
      return json as AuthSettings
    },
    [adminKey]
  )

  return { data, loading, error, refresh, save }
}
