import { useState } from 'react'
import { AlertCircle, Check, Copy, Loader2 } from 'lucide-react'
import { useAuthUsers } from '@/hooks/useAuthUsers'

function formatRelative(ms: number | null): string {
  if (!ms) return '—'
  const seconds = Math.floor((Date.now() - ms) / 1000)
  if (seconds < 45) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(ms).toLocaleDateString()
}

function formatAbsolute(ms: number | null): string {
  if (!ms) return ''
  return new Date(ms).toLocaleString()
}

function providerLabel(id: string): string {
  if (id === 'password') return 'Email'
  if (id === 'google') return 'Google'
  if (id === 'github') return 'GitHub'
  if (id === 'microsoft') return 'Microsoft'
  if (id === 'apple') return 'Apple'
  return id
}

export function AuthUsers({ adminKey }: { adminKey: string }) {
  const { users, loading, error } = useAuthUsers(adminKey)
  const [copied, setCopied] = useState<string | null>(null)

  async function copy(text: string) {
    await navigator.clipboard.writeText(text)
    setCopied(text)
    setTimeout(() => setCopied(null), 1500)
  }

  return (
    <section className="space-y-3 px-5 pt-5">
      <div>
        <h3 className="text-sm font-medium text-zinc-900">Users</h3>
        <p className="text-xs text-zinc-500">
          Everyone who has signed up. Last signed in is the most recent session.
        </p>
      </div>

      {loading && (
        <div className="flex items-center gap-2 py-8 text-sm text-zinc-400">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading users...
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 py-4 text-sm text-red-500">
          <AlertCircle className="h-4 w-4" /> {error}
        </div>
      )}

      {!loading && !error && users.length === 0 && (
        <div className="rounded border border-zinc-200 bg-white px-4 py-8 text-center text-sm text-zinc-400">
          No users yet. They show up here when someone signs in.
        </div>
      )}

      {!loading && !error && users.length > 0 && (
        <div className="overflow-x-auto rounded border border-zinc-200 bg-white">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-200 bg-zinc-50 text-[11px] uppercase tracking-wide text-zinc-500">
                <th className="px-3 py-2 font-medium">Identifier</th>
                <th className="px-3 py-2 font-medium">User UID</th>
                <th className="px-3 py-2 font-medium">Providers</th>
                <th className="px-3 py-2 font-medium">Created</th>
                <th className="px-3 py-2 font-medium">Last signed in</th>
                <th className="px-3 py-2 font-medium">Role</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-b border-zinc-100 last:border-0 hover:bg-zinc-50">
                  <td className="px-3 py-2">
                    <div className="text-zinc-900">{u.email || '—'}</div>
                    {u.name && <div className="text-[11px] text-zinc-400">{u.name}</div>}
                  </td>
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      onClick={() => copy(u.id)}
                      title="Copy UID"
                      className="inline-flex max-w-[180px] items-center gap-1 font-mono text-xs text-zinc-600 hover:text-zinc-900"
                    >
                      <span className="truncate">{u.id}</span>
                      {copied === u.id ? (
                        <Check className="h-3 w-3 shrink-0 text-emerald-500" />
                      ) : (
                        <Copy className="h-3 w-3 shrink-0 text-zinc-400" />
                      )}
                    </button>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      {(u.providers.length ? u.providers : ['—']).map((p) => (
                        <span
                          key={p}
                          className="rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-600"
                        >
                          {providerLabel(p)}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-xs text-zinc-600" title={formatAbsolute(u.created)}>
                    {formatRelative(u.created)}
                  </td>
                  <td className="px-3 py-2 text-xs text-zinc-600" title={formatAbsolute(u.lastLogin)}>
                    {formatRelative(u.lastLogin)}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-zinc-500">{u.role}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
