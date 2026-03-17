import { useEffect, useRef, useState } from 'react'
import type { EzDocument } from '@/hooks/useDocuments'

const HEADER_HEIGHT = 33
const ROW_HEIGHT = 36
const OVERSCAN = 10
const ID_COLUMN_WIDTH = 240
const DATA_COLUMN_WIDTH = 220
const TIME_COLUMN_WIDTH = 140

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

function stringifyValue(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return ''
  if (typeof value === 'object') {
    return JSON.stringify(value)
  }
  return String(value)
}

function formatValue(value: unknown): string {
  const text = stringifyValue(value)
  return text.length > 120 ? text.slice(0, 117) + '...' : text
}

export function DocumentTable({ documents }: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [viewportHeight, setViewportHeight] = useState(0)
  const [scrollTop, setScrollTop] = useState(0)
  const [dataKeys, setDataKeys] = useState<string[]>([])

  useEffect(() => {
    const keys = new Set<string>()
    for (const doc of documents) {
      for (const key of Object.keys(doc.data)) {
        keys.add(key)
      }
    }
    setDataKeys(Array.from(keys).sort())
  }, [documents])

  useEffect(() => {
    const node = scrollRef.current
    if (!node) return

    const updateViewportHeight = () => {
      setViewportHeight(node.clientHeight)
    }

    updateViewportHeight()

    const observer = new ResizeObserver(updateViewportHeight)
    observer.observe(node)

    return () => {
      observer.disconnect()
    }
  }, [])

  const availableHeight = Math.max(viewportHeight - HEADER_HEIGHT, ROW_HEIGHT)
  const bodyScrollTop = Math.max(0, scrollTop - HEADER_HEIGHT)
  const visibleRowCount = Math.ceil(availableHeight / ROW_HEIGHT)
  const startIndex = Math.max(0, Math.floor(bodyScrollTop / ROW_HEIGHT) - OVERSCAN)
  const endIndex = Math.min(documents.length, startIndex + visibleRowCount + OVERSCAN * 2)
  const visibleDocuments = documents.slice(startIndex, endIndex)

  const gridTemplateColumns = [
    `${ID_COLUMN_WIDTH}px`,
    ...dataKeys.map(() => `${DATA_COLUMN_WIDTH}px`),
    `${TIME_COLUMN_WIDTH}px`,
    `${TIME_COLUMN_WIDTH}px`,
  ].join(' ')
  const gridWidth =
    ID_COLUMN_WIDTH +
    dataKeys.length * DATA_COLUMN_WIDTH +
    TIME_COLUMN_WIDTH * 2

  return (
    <div
      ref={scrollRef}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      className="h-full overflow-auto bg-white"
    >
      <div className="sticky top-0 z-20 border-b border-zinc-200 bg-zinc-50" style={{ minWidth: gridWidth }}>
        <div
          className="grid text-[11px] uppercase tracking-wide text-zinc-500"
          style={{ gridTemplateColumns, height: HEADER_HEIGHT }}
        >
          <div className="flex items-center border-r border-zinc-200 px-3 font-medium">id</div>
          {dataKeys.map((key) => (
            <div key={key} className="flex items-center border-r border-zinc-200 px-3 font-medium">
              {key}
            </div>
          ))}
          <div className="flex items-center border-r border-zinc-200 px-3 font-medium">created</div>
          <div className="flex items-center px-3 font-medium">updated</div>
        </div>
      </div>

      <div className="relative" style={{ height: documents.length * ROW_HEIGHT, minWidth: gridWidth }}>
        {visibleDocuments.map((doc, index) => {
          const rowIndex = startIndex + index

          return (
            <div
              key={doc.id}
              className={`absolute left-0 grid border-b border-zinc-100 ${
                rowIndex % 2 === 0 ? 'bg-white' : 'bg-zinc-50/50'
              } hover:bg-sky-50`}
              style={{
                top: rowIndex * ROW_HEIGHT,
                gridTemplateColumns,
                height: ROW_HEIGHT,
                minWidth: gridWidth,
              }}
            >
              <div className="flex min-w-0 items-center border-r border-zinc-100 px-3 font-mono text-xs text-zinc-400">
                <span className="truncate">{doc.id}</span>
              </div>
              {dataKeys.map((key) => {
                const value = formatValue(doc.data[key])

                return (
                  <div
                    key={key}
                    className="flex min-w-0 items-center border-r border-zinc-100 px-3 font-mono text-xs text-zinc-800"
                    title={stringifyValue(doc.data[key])}
                  >
                    <span className="truncate">{value}</span>
                  </div>
                )
              })}
              <div
                className="flex items-center border-r border-zinc-100 px-3 text-xs text-zinc-400"
                title={new Date(doc.created).toISOString()}
              >
                {formatTime(doc.created)}
              </div>
              <div
                className="flex items-center px-3 text-xs text-zinc-400"
                title={new Date(doc.updated).toISOString()}
              >
                {formatTime(doc.updated)}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
