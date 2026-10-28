import { useState } from 'react'
import type { CollectionStats } from '@/hooks/useCollectionStats'
import { bytes, num } from '@/lib/api'

interface Props {
  stats: CollectionStats[]
  onSelectCollection: (name: string) => void
}

type SortKey = 'name' | 'count' | 'size'

export function Dashboard({ stats, onSelectCollection }: Props) {
  const [sort, setSort] = useState<SortKey>('count')
  const [query, setQuery] = useState('')

  const totalDocs = stats.reduce((sum, s) => sum + s.count, 0)
  const totalSize = stats.reduce((sum, s) => sum + s.size, 0)
  const maxSize = Math.max(1, ...stats.map((s) => s.size))
  const q = query.trim().toLowerCase()
  const rows = stats
    .filter((s) => !q || s.name.toLowerCase().includes(q))
    .sort((a, b) => (sort === 'name' ? a.name.localeCompare(b.name) : b[sort] - a[sort]))

  const header = (key: SortKey, label: string, align = 'text-left') => (
    <th className={`py-2 font-medium ${align} ${key === 'name' ? 'pl-4' : 'pr-4'}`}>
      <button type="button" onClick={() => setSort(key)} className={sort === key ? 'text-zinc-900' : 'hover:text-zinc-800'}>
        {label}
      </button>
    </th>
  )

  return (
    <div className="flex-1 overflow-y-auto px-6 py-5">
      <div className="mb-4 flex items-end justify-between gap-4">
        <div className="flex gap-8">
          <div>
            <div className="text-2xl font-semibold tabular-nums text-zinc-900">{num(stats.length)}</div>
            <div className="text-sm text-zinc-500">collections</div>
          </div>
          <div>
            <div className="text-2xl font-semibold tabular-nums text-zinc-900">{num(totalDocs)}</div>
            <div className="text-sm text-zinc-500">documents</div>
          </div>
          <div>
            <div className="text-2xl font-semibold tabular-nums text-zinc-900">{bytes(totalSize)}</div>
            <div className="text-sm text-zinc-500">data</div>
          </div>
        </div>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search collections"
          className="w-64 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-sky-500"
        />
      </div>

      <div className="overflow-hidden rounded-md border border-zinc-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-200 bg-zinc-50 text-xs text-zinc-500">
              {header('name', 'Collection')}
              {header('count', 'Documents', 'text-right')}
              {header('size', 'Data', 'text-right')}
              <th className="w-[40%] py-2 pr-4" />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={4} className="py-10 text-center text-sm text-zinc-500">{stats.length ? 'No collections match' : 'No collections'}</td></tr>
            )}
            {rows.map((s) => (
              <tr key={s.name} onClick={() => onSelectCollection(s.name)} className="cursor-pointer border-b border-zinc-100 last:border-0 hover:bg-zinc-50">
                <td className="py-2 pl-4 font-mono text-[13px] text-zinc-900">{s.name}</td>
                <td className="py-2 pr-4 text-right font-mono text-[13px] tabular-nums text-zinc-700">{num(s.count)}</td>
                <td className="py-2 pr-4 text-right font-mono text-[13px] tabular-nums text-zinc-700">{bytes(s.size)}</td>
                <td className="py-2 pr-4">
                  <span className="block h-1.5 rounded-full bg-zinc-100">
                    <span className="block h-full rounded-full bg-sky-500" style={{ width: `${(s.size / maxSize) * 100}%` }} />
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
