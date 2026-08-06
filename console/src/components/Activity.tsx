import { useMemo, useState } from 'react'
import { AlertCircle, Radio } from 'lucide-react'
import { useAnalytics, useLiveRequests, type TimeseriesPoint } from '@/hooks/useAnalytics'

const BAR_COLOR = '#0284c7' // sky-600
const ERROR_COLOR = '#ef4444' // red-500

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white px-4 py-3">
      <div className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">{label}</div>
      <div className="mt-1 font-mono text-2xl font-semibold text-zinc-900">{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-zinc-400">{sub}</div>}
    </div>
  )
}

/** Requests-per-minute over the last hour — stacked ok/error bars */
function RequestsChart({ series }: { series: TimeseriesPoint[] }) {
  const [hover, setHover] = useState<number | null>(null)

  const minutes = useMemo(() => {
    const byTs = new Map(series.map((p) => [p.ts, p]))
    const nowMin = Math.floor(Date.now() / 60000) * 60000
    const out: TimeseriesPoint[] = []
    for (let i = 59; i >= 0; i--) {
      const ts = nowMin - i * 60000
      out.push(byTs.get(ts) ?? { ts, requests: 0, errors: 0, avgMs: 0 })
    }
    return out
  }, [series])

  const W = 720
  const H = 160
  const PAD_TOP = 8
  const max = Math.max(4, ...minutes.map((m) => m.requests))
  const slot = W / 60
  const barW = Math.max(2, slot - 2)
  const y = (v: number) => H - (v / max) * (H - PAD_TOP)

  const fmtTime = (ts: number) =>
    new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  const hovered = hover !== null ? minutes[hover] : null

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H + 18}`} className="w-full" role="img" aria-label="Requests per minute, last hour">
        {/* recessive gridlines */}
        {[0.5, 1].map((f) => (
          <g key={f}>
            <line x1={0} x2={W} y1={y(max * f)} y2={y(max * f)} stroke="#e4e4e7" strokeWidth={1} />
            <text x={W - 2} y={y(max * f) - 3} textAnchor="end" className="fill-zinc-400" fontSize={9}>
              {Math.round(max * f)}
            </text>
          </g>
        ))}
        {minutes.map((m, i) => {
          const x = i * slot + (slot - barW) / 2
          const okH = Math.max(0, y(m.requests - m.errors) )
          return (
            <g key={m.ts}>
              {m.requests > 0 && (
                <>
                  {/* ok segment (rounded top), error segment stacked above with 2px gap */}
                  <rect x={x} y={okH} width={barW} height={H - okH} rx={2} fill={BAR_COLOR} opacity={hover === null || hover === i ? 1 : 0.45} />
                  {m.errors > 0 && (
                    <rect x={x} y={y(m.requests)} width={barW} height={Math.max(2, okH - y(m.requests) - 2)} rx={2} fill={ERROR_COLOR} opacity={hover === null || hover === i ? 1 : 0.45} />
                  )}
                </>
              )}
              {/* full-height hit target, bigger than the mark */}
              <rect
                x={i * slot} y={0} width={slot} height={H}
                fill="transparent"
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
              />
            </g>
          )
        })}
        <line x1={0} x2={W} y1={H} y2={H} stroke="#d4d4d8" strokeWidth={1} />
        {[45, 30, 15, 0].map((ago) => (
          <text key={ago} x={(59 - ago) * slot + slot / 2} y={H + 13} textAnchor="middle" className="fill-zinc-400" fontSize={9}>
            {ago === 0 ? 'now' : `-${ago}m`}
          </text>
        ))}
      </svg>

      {hovered && hover !== null && (
        <div
          className="pointer-events-none absolute -top-1 z-10 -translate-x-1/2 rounded border border-zinc-200 bg-white px-2.5 py-1.5 text-[11px] shadow-md"
          style={{ left: `${((hover + 0.5) / 60) * 100}%` }}
        >
          <div className="font-medium text-zinc-700">{fmtTime(hovered.ts)}</div>
          <div className="font-mono text-zinc-600">{hovered.requests} req{hovered.errors > 0 ? ` · ${hovered.errors} err` : ''}</div>
          {hovered.requests > 0 && <div className="font-mono text-zinc-400">{hovered.avgMs}ms avg</div>}
        </div>
      )}

      {/* legend — two series, color never alone */}
      <div className="mt-1 flex items-center gap-4 text-[11px] text-zinc-500">
        <span className="flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-sm" style={{ background: BAR_COLOR }} /> requests</span>
        <span className="flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-sm" style={{ background: ERROR_COLOR }} /> errors</span>
      </div>
    </div>
  )
}

function statusClass(status: number) {
  if (status >= 500) return 'text-red-600'
  if (status >= 400) return 'text-amber-600'
  return 'text-emerald-600'
}

export function Activity({ adminKey }: { adminKey: string }) {
  const { summary, series, error } = useAnalytics(adminKey)
  const live = useLiveRequests(adminKey)

  const lastMinute = series[series.length - 1]?.requests ?? 0

  if (error) {
    return (
      <div className="flex items-center justify-center gap-2 py-20 text-sm text-red-500">
        <AlertCircle className="h-4 w-4" /> {error}
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-base font-semibold text-zinc-900">Activity</h2>
        <div className="flex items-center gap-1.5 text-xs text-emerald-600">
          <Radio className="h-3 w-3" /> Live
        </div>
      </div>

      {/* Stat tiles */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Requests · 24h" value={(summary?.requests ?? 0).toLocaleString()} />
        <StatTile
          label="Errors · 24h"
          value={(summary?.errors ?? 0).toLocaleString()}
          sub={summary && summary.requests > 0 ? `${((summary.errors / summary.requests) * 100).toFixed(2)}% error rate` : undefined}
        />
        <StatTile label="Avg response" value={`${summary?.avgMs ?? 0}ms`} />
        <StatTile label="Last minute" value={`${lastMinute} req`} />
      </div>

      {/* Chart */}
      <div className="mt-4 rounded-lg border border-zinc-200 bg-white p-4">
        <div className="mb-2 text-xs font-medium text-zinc-500">Requests per minute — last hour</div>
        <RequestsChart series={series} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        {/* Top collections */}
        <div className="rounded-lg border border-zinc-200 bg-white p-4">
          <div className="mb-2 text-xs font-medium text-zinc-500">Top collections — 24h</div>
          {(!summary || summary.topCollections.length === 0) && (
            <div className="py-6 text-center text-xs text-zinc-400">No collection traffic yet</div>
          )}
          {summary && summary.topCollections.length > 0 && (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-zinc-400">
                  <th className="pb-1.5 font-medium">Collection</th>
                  <th className="pb-1.5 text-right font-medium">Requests</th>
                  <th className="pb-1.5 text-right font-medium">Errors</th>
                  <th className="pb-1.5 text-right font-medium">Avg</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {summary.topCollections.map((tc) => (
                  <tr key={`${tc.database}/${tc.collection}`} className="border-t border-zinc-100">
                    <td className="py-1.5 text-zinc-700">
                      {tc.database !== 'default' && <span className="text-zinc-400">{tc.database}/</span>}
                      {tc.collection}
                    </td>
                    <td className="py-1.5 text-right text-zinc-600">{tc.requests.toLocaleString()}</td>
                    <td className={`py-1.5 text-right ${tc.errors > 0 ? 'text-red-600' : 'text-zinc-400'}`}>{tc.errors}</td>
                    <td className="py-1.5 text-right text-zinc-400">{tc.avgMs}ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Live feed */}
        <div className="rounded-lg border border-zinc-200 bg-white p-4">
          <div className="mb-2 text-xs font-medium text-zinc-500">Live requests</div>
          {live.length === 0 && <div className="py-6 text-center text-xs text-zinc-400">Waiting for traffic…</div>}
          <div className="max-h-72 space-y-0.5 overflow-y-auto font-mono text-[11px]">
            {live.map((r, i) => (
              <div key={`${r.ts}-${i}`} className="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-zinc-50">
                <span className="w-14 shrink-0 text-zinc-400">
                  {new Date(r.ts).toLocaleTimeString([], { hour12: false })}
                </span>
                <span className={`w-9 shrink-0 font-semibold ${statusClass(r.status)}`}>{r.status}</span>
                <span className="w-12 shrink-0 text-zinc-500">{r.method}</span>
                <span className="flex-1 truncate text-zinc-600">{r.path.replace(/^\/api/, '')}</span>
                <span className="w-12 shrink-0 text-right text-zinc-400">{r.op === 'realtime' ? 'sse' : `${r.ms}ms`}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
