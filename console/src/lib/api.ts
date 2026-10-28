export const ADMIN_KEY_STORAGE = 'ezbase_admin_key'

export function adminKey(): string {
  return localStorage.getItem(ADMIN_KEY_STORAGE) || ''
}

export function dbBase(database: string): string {
  return database === 'default' ? '/api' : `/api/db/${encodeURIComponent(database)}`
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

/** JSON request with the admin key; non-2xx responses throw the server's `error` message. */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      Authorization: `Bearer ${adminKey()}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(body?.error || `${res.status} ${res.statusText}`, res.status)
  }
  return res.json() as Promise<T>
}

export const num = (n: number) => n.toLocaleString('en-US')

export function bytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} B`
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

export function pct(part: number, whole: number): string {
  if (!whole) return '0%'
  const v = (part / whole) * 100
  if (v === 100 || v === 0) return `${v}%`
  if (v > 99.9 && v < 100) return `${v.toFixed(2)}%`
  if (v < 0.1) return '<0.1%'
  return `${v.toFixed(1)}%`
}

export type JsonType = 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array'

/** One color per JSON type, everywhere in the console. */
export const TYPE_COLOR: Record<JsonType | 'missing', string> = {
  string: '#0ea5e9',
  number: '#16a34a',
  boolean: '#0d9488',
  object: '#475569',
  array: '#ca8a04',
  null: '#9ca3af',
  missing: 'transparent',
}

export function typeOf(value: unknown): JsonType {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value as JsonType
}
