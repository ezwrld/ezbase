import { useState } from 'react'
import { Database, FileText, HardDrive, Radio } from 'lucide-react'
import type { CollectionStats } from '@/hooks/useCollectionStats'
import { PieChart, getColor, type PieSlice } from './PieChart'

interface Props {
  stats: CollectionStats[]
  onSelectCollection: (name: string) => void
}

type PieMode = 'count' | 'size'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function Dashboard({ stats, onSelectCollection }: Props) {
  const [pieMode, setPieMode] = useState<PieMode>('count')

  const sorted = [...stats].sort((a, b) => a.name.localeCompare(b.name))
  const totalDocs = sorted.reduce((sum, s) => sum + s.count, 0)
  const totalSize = sorted.reduce((sum, s) => sum + s.size, 0)

  const slices: PieSlice[] = sorted.map((s, i) => ({
    label: s.name,
    value: pieMode === 'count' ? s.count : s.size,
    color: getColor(i),
  }))

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-zinc-200 bg-white px-5 py-3">
        <div className="flex items-center gap-3">
          <h2 className="text-base font-semibold text-zinc-900">Overview</h2>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-emerald-600">
          <Radio className="h-3 w-3" />
          Live
        </div>
      </div>

      <div className="p-5">
        {/* Stat cards */}
        <div className="mb-6 grid grid-cols-3 gap-4">
          <div className="rounded-lg border border-zinc-200 bg-white p-4">
            <div className="flex items-center gap-2 text-xs font-medium text-zinc-500">
              <Database className="h-3.5 w-3.5" />
              Collections
            </div>
            <div className="mt-1 font-mono text-2xl font-semibold text-zinc-900">
              {sorted.length}
            </div>
          </div>
          <div className="rounded-lg border border-zinc-200 bg-white p-4">
            <div className="flex items-center gap-2 text-xs font-medium text-zinc-500">
              <FileText className="h-3.5 w-3.5" />
              Total Documents
            </div>
            <div className="mt-1 font-mono text-2xl font-semibold text-zinc-900">
              {totalDocs.toLocaleString()}
            </div>
          </div>
          <div className="rounded-lg border border-zinc-200 bg-white p-4">
            <div className="flex items-center gap-2 text-xs font-medium text-zinc-500">
              <HardDrive className="h-3.5 w-3.5" />
              Data Size
            </div>
            <div className="mt-1 font-mono text-2xl font-semibold text-zinc-900">
              {formatBytes(totalSize)}
            </div>
          </div>
        </div>

        {/* Pie chart + legend */}
        <div className="rounded-lg border border-zinc-200 bg-white p-5">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-zinc-900">Collections Breakdown</h3>
            <div className="flex gap-1 rounded-md border border-zinc-200 p-0.5 text-[11px] font-medium">
              <button
                onClick={() => setPieMode('count')}
                className={`rounded px-2 py-0.5 transition-colors ${
                  pieMode === 'count'
                    ? 'bg-zinc-900 text-white'
                    : 'text-zinc-500 hover:text-zinc-700'
                }`}
              >
                Count
              </button>
              <button
                onClick={() => setPieMode('size')}
                className={`rounded px-2 py-0.5 transition-colors ${
                  pieMode === 'size'
                    ? 'bg-zinc-900 text-white'
                    : 'text-zinc-500 hover:text-zinc-700'
                }`}
              >
                Size
              </button>
            </div>
          </div>

          <div className="flex items-start gap-8">
            <PieChart slices={slices} size={180} />

            {/* Legend */}
            <div className="flex flex-1 flex-col gap-1.5">
              {sorted.map((s, i) => (
                <button
                  key={s.name}
                  onClick={() => onSelectCollection(s.name)}
                  className="group flex items-center justify-between rounded px-2 py-1 text-left transition-colors hover:bg-zinc-50"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
                      style={{ backgroundColor: getColor(i) }}
                    />
                    <span className="font-mono text-xs text-zinc-700 group-hover:text-zinc-900">
                      {s.name}
                    </span>
                  </div>
                  <span className="font-mono text-xs text-zinc-400">
                    {pieMode === 'count'
                      ? `${s.count} doc${s.count !== 1 ? 's' : ''}`
                      : formatBytes(s.size)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
