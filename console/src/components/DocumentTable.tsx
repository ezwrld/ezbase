import type { EzDocument } from '@/hooks/useDocuments'

interface Props {
  documents: EzDocument[]
}

function formatTime(ms: number): string {
  const seconds = Math.floor((Date.now() - ms) / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function formatValue(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return ''
  if (typeof value === 'object') {
    const json = JSON.stringify(value)
    return json.length > 80 ? json.slice(0, 77) + '...' : json
  }
  return String(value)
}

export function DocumentTable({ documents }: Props) {
  const dataKeys = Array.from(
    new Set(documents.flatMap((doc) => Object.keys(doc.data)))
  ).sort()

  return (
    <div className="overflow-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-zinc-200 bg-zinc-50 text-[11px] uppercase tracking-wide text-zinc-500">
            <th className="whitespace-nowrap px-3 py-2 font-medium">id</th>
            {dataKeys.map((key) => (
              <th key={key} className="whitespace-nowrap px-3 py-2 font-medium">{key}</th>
            ))}
            <th className="whitespace-nowrap px-3 py-2 font-medium">created</th>
            <th className="whitespace-nowrap px-3 py-2 font-medium">updated</th>
          </tr>
        </thead>
        <tbody>
          {documents.map((doc) => (
            <tr key={doc.id} className="border-b border-zinc-100 hover:bg-zinc-50">
              <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-zinc-400">
                {doc.id}
              </td>
              {dataKeys.map((key) => (
                <td key={key} className="max-w-xs truncate px-3 py-2 font-mono text-xs text-zinc-800" title={formatValue(doc.data[key])}>
                  {formatValue(doc.data[key])}
                </td>
              ))}
              <td className="whitespace-nowrap px-3 py-2 text-xs text-zinc-400"
                  title={new Date(doc.created).toISOString()}>
                {formatTime(doc.created)}
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-xs text-zinc-400"
                  title={new Date(doc.updated).toISOString()}>
                {formatTime(doc.updated)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
