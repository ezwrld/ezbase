import { useEffect, useState } from 'react'
import { Loader2, AlertCircle, Check, Copy, Lock } from 'lucide-react'
import { useAuthSettings, type ProviderId } from '@/hooks/useAuthSettings'
import { AuthUsers } from '@/components/AuthUsers'

const PROVIDERS: { id: ProviderId; name: string; hint: string }[] = [
  { id: 'google', name: 'Google', hint: 'Google Cloud → APIs & Services → Credentials → OAuth client ID (Web)' },
  { id: 'github', name: 'GitHub', hint: 'GitHub → Settings → Developer settings → OAuth Apps' },
  { id: 'microsoft', name: 'Microsoft', hint: 'Entra → App registrations → New registration' },
  { id: 'apple', name: 'Apple', hint: 'Paid Apple Developer account. Skip unless you need it.' },
]

type DraftProvider = {
  enabled: boolean
  clientId: string
  clientSecret: string
}

export function AuthSettings({ adminKey }: { adminKey: string }) {
  const { data, loading, error, save } = useAuthSettings(adminKey)
  const [publicUrl, setPublicUrl] = useState('')
  const [authOrigin, setAuthOrigin] = useState('')
  const [providers, setProviders] = useState<Record<ProviderId, DraftProvider> | null>(null)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  useEffect(() => {
    if (!data) return
    setPublicUrl(data.publicUrl)
    setAuthOrigin(data.extraOrigins[0] || '')
    const next = {} as Record<ProviderId, DraftProvider>
    for (const p of PROVIDERS) {
      next[p.id] = {
        enabled: data.providers[p.id].enabled,
        clientId: data.providers[p.id].clientId,
        clientSecret: '',
      }
    }
    setProviders(next)
  }, [data])

  async function copy(text: string) {
    await navigator.clipboard.writeText(text)
    setCopied(text)
    setTimeout(() => setCopied(null), 1500)
  }

  async function handleSave() {
    if (!providers || !data) return
    setSaveStatus('saving')
    setSaveError(null)
    try {
      const bodyProviders: Record<string, { enabled: boolean; clientId: string; clientSecret?: string } | null> = {}
      for (const p of PROVIDERS) {
        const d = providers[p.id]
        if (!d.enabled) {
          bodyProviders[p.id] = { enabled: false, clientId: '' }
        } else {
          bodyProviders[p.id] = {
            enabled: true,
            clientId: d.clientId.trim(),
            ...(d.clientSecret.trim() ? { clientSecret: d.clientSecret.trim() } : {}),
          }
        }
      }
      await save({
        publicUrl: publicUrl.trim(),
        extraOrigins: authOrigin.trim() ? [authOrigin.trim()] : [],
        providers: bodyProviders,
      })
      setSaveStatus('saved')
      setProviders((prev) => {
        if (!prev) return prev
        const cleared = { ...prev }
        for (const p of PROVIDERS) cleared[p.id] = { ...cleared[p.id], clientSecret: '' }
        return cleared
      })
      setTimeout(() => setSaveStatus('idle'), 2000)
    } catch (err) {
      setSaveStatus('error')
      setSaveError(err instanceof Error ? err.message : 'Save failed')
    }
  }

  const readonly = data?.readonly ?? false
  const callbackBase = `${publicUrl.replace(/\/$/, '')}/api/auth/callback`
  let impliedOrigin = publicUrl
  try {
    impliedOrigin = new URL(publicUrl).origin
  } catch {}

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-zinc-200 bg-white px-5 py-3">
        <h2 className="font-mono text-base font-semibold text-zinc-900">Auth</h2>
        <div className="flex items-center gap-2">
          {saveStatus === 'saved' && (
            <span className="flex items-center gap-1 text-xs text-emerald-600">
              <Check className="h-3 w-3" /> Saved
            </span>
          )}
          {saveStatus === 'error' && <span className="text-xs text-red-500">{saveError}</span>}
          {providers && !readonly && (
            <button
              onClick={handleSave}
              disabled={saveStatus === 'saving'}
              className="rounded bg-sky-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-sky-600 disabled:opacity-50"
            >
              {saveStatus === 'saving' ? 'Saving...' : 'Save'}
            </button>
          )}
        </div>
      </div>

      {readonly && (
        <div className="border-b border-amber-200 bg-amber-50 px-5 py-2 text-xs text-amber-700">
          <Lock className="mr-1 inline h-3 w-3" />
          auth.json is read-only on this instance. Edit the file on the host, or unset the mount.
        </div>
      )}

      <div className="flex-1 overflow-auto">
        <AuthUsers adminKey={adminKey} />

        <div className="mx-auto max-w-2xl space-y-8 p-5">
          {(loading || !providers) && !error && (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />
            </div>
          )}

          {error && (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-red-500">
              <AlertCircle className="h-4 w-4" /> {error}
            </div>
          )}

          {providers && !error && (
            <>
          <section className="space-y-2">
            <h3 className="text-sm font-medium text-zinc-900">Public URL</h3>
            <p className="text-xs text-zinc-500">
              How browsers reach this ezbase. Include the path if you mount it there
              (Aura is <span className="font-mono">https://aura.tl/ez</span>). Google sends users back here.
            </p>
            <input
              value={publicUrl}
              onChange={(e) => setPublicUrl(e.target.value)}
              readOnly={readonly}
              placeholder="https://your.domain/ez"
              className="w-full rounded border border-zinc-300 bg-white px-3 py-2 font-mono text-sm text-zinc-900 outline-none focus:border-sky-400 focus:ring-1 focus:ring-sky-400 disabled:bg-zinc-50"
            />
          </section>

          <section className="space-y-2">
            <h3 className="text-sm font-medium text-zinc-900">Auth origin</h3>
            <p className="text-xs text-zinc-500">
              The website that signs users in. Host only —{' '}
              <span className="font-mono">https://app.whatever.com</span> — no path.
              Same host as the public URL is already allowed
              ({impliedOrigin}).
              Fill this in only if the app lives on a <em>different</em> host (subdomain, Vercel, etc.).
            </p>
            <input
              value={authOrigin}
              onChange={(e) => setAuthOrigin(e.target.value)}
              readOnly={readonly}
              placeholder="https://app.whatever.com"
              className="w-full rounded border border-zinc-300 bg-white px-3 py-2 font-mono text-sm text-zinc-900 outline-none focus:border-sky-400 focus:ring-1 focus:ring-sky-400"
            />
          </section>

          <section className="space-y-3">
            <div>
              <h3 className="text-sm font-medium text-zinc-900">Sign-in providers</h3>
              <p className="text-xs text-zinc-500">
                Email and password is always on. Turn on a provider, paste its client ID and secret,
                copy the callback URL into that provider&apos;s console.
              </p>
            </div>

            {PROVIDERS.map((p) => {
              const d = providers[p.id]
              const meta = data!.providers[p.id]
              const callback = `${callbackBase}/${p.id}`
              return (
                <div key={p.id} className="rounded border border-zinc-200 bg-white p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium text-zinc-900">{p.name}</div>
                      <div className="text-xs text-zinc-500">{p.hint}</div>
                    </div>
                    <label className="flex items-center gap-2 text-xs text-zinc-600">
                      <input
                        type="checkbox"
                        checked={d.enabled}
                        disabled={readonly}
                        onChange={(e) =>
                          setProviders({ ...providers, [p.id]: { ...d, enabled: e.target.checked } })
                        }
                      />
                      {d.enabled ? 'On' : 'Off'}
                    </label>
                  </div>

                  {d.enabled && (
                    <div className="mt-3 space-y-2">
                      <label className="block text-[11px] font-medium text-zinc-500">Client ID</label>
                      <input
                        value={d.clientId}
                        onChange={(e) =>
                          setProviders({ ...providers, [p.id]: { ...d, clientId: e.target.value } })
                        }
                        readOnly={readonly}
                        className="w-full rounded border border-zinc-300 px-2 py-1.5 font-mono text-xs outline-none focus:border-sky-400"
                      />
                      <label className="block text-[11px] font-medium text-zinc-500">
                        Client secret {meta.clientSecretSet ? '(leave blank to keep)' : ''}
                      </label>
                      <input
                        type="password"
                        value={d.clientSecret}
                        onChange={(e) =>
                          setProviders({ ...providers, [p.id]: { ...d, clientSecret: e.target.value } })
                        }
                        readOnly={readonly}
                        placeholder={meta.clientSecretSet ? '••••••••' : ''}
                        className="w-full rounded border border-zinc-300 px-2 py-1.5 font-mono text-xs outline-none focus:border-sky-400"
                      />
                      <div className="flex items-center gap-2 pt-1">
                        <span className="truncate font-mono text-[11px] text-zinc-500">{callback}</span>
                        <button
                          type="button"
                          onClick={() => copy(callback)}
                          className="shrink-0 rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
                          title="Copy callback URL"
                        >
                          {copied === callback ? (
                            <Check className="h-3.5 w-3.5 text-emerald-500" />
                          ) : (
                            <Copy className="h-3.5 w-3.5" />
                          )}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </section>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
