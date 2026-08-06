import { useState, useEffect, useRef } from 'react'

export interface AnalyticsSummary {
  hours: number
  requests: number
  errors: number
  avgMs: number
  byOp: { op: string; requests: number; errors: number }[]
  topCollections: { database: string; collection: string; requests: number; errors: number; avgMs: number }[]
}

export interface TimeseriesPoint {
  ts: number
  requests: number
  errors: number
  avgMs: number
}

export interface LiveRequest {
  ts: number
  method: string
  path: string
  op: string
  database: string
  collection: string
  status: number
  ms: number
  role: string
}

export function useAnalytics(adminKey: string) {
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null)
  const [series, setSeries] = useState<TimeseriesPoint[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!adminKey) return
    let cancelled = false

    const load = async () => {
      try {
        const headers = { Authorization: `Bearer ${adminKey}` }
        const [sumRes, tsRes] = await Promise.all([
          fetch('/api/analytics/summary', { headers }),
          fetch('/api/analytics/timeseries?minutes=60', { headers }),
        ])
        if (!sumRes.ok || !tsRes.ok) throw new Error('Failed to load analytics')
        if (cancelled) return
        setSummary(await sumRes.json())
        setSeries(await tsRes.json())
        setError(null)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load analytics')
      }
    }

    load()
    const timer = setInterval(load, 10000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [adminKey])

  return { summary, series, error }
}

export function useLiveRequests(adminKey: string, max = 60) {
  const [requests, setRequests] = useState<LiveRequest[]>([])
  const esRef = useRef<EventSource | null>(null)

  useEffect(() => {
    if (!adminKey) return
    // EventSource can't set headers — pass the admin key as a query token
    const es = new EventSource(`/api/analytics/live?token=${encodeURIComponent(adminKey)}`)
    esRef.current = es
    es.addEventListener('request', (e) => {
      try {
        const req = JSON.parse((e as MessageEvent).data) as LiveRequest
        setRequests((prev) => [req, ...prev].slice(0, max))
      } catch {}
    })
    return () => es.close()
  }, [adminKey, max])

  return requests
}
