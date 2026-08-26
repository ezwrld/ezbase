import * as fs from 'node:fs'
import * as path from 'node:path'

export const PROVIDERS = ['google', 'github', 'microsoft', 'apple'] as const
export type ProviderId = (typeof PROVIDERS)[number]

export type ProviderCreds = { clientId: string; clientSecret: string }

export type AuthFile = {
  publicUrl?: string
  extraOrigins?: string[]
  providers?: Partial<Record<ProviderId, ProviderCreds | null>>
}

export type ProviderView = {
  enabled: boolean
  clientId: string
  clientSecretSet: boolean
}

export type AuthSettingsView = {
  publicUrl: string
  extraOrigins: string[]
  callbackBase: string
  providers: Record<ProviderId, ProviderView>
  emailPassword: true
  readonly: boolean
}

type EffectiveProvider = {
  enabled: boolean
  clientId: string
  clientSecret: string
}

export type EffectiveAuth = {
  publicUrl: string
  extraOrigins: string[]
  trustedOrigins: string[]
  providers: Record<ProviderId, EffectiveProvider>
}

const AUTH_PATH = process.env.AUTH_SETTINGS_PATH || '/data/auth.json'

let file: AuthFile = {}
let readonly = false

function defaultPublicUrl(): string {
  const port = parseInt(process.env.PORT || '8080')
  return `http://localhost:${port}`
}

export function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return url
  }
}

function loadFromDisk(): void {
  try {
    if (!fs.existsSync(AUTH_PATH)) {
      file = {}
      readonly = false
      try {
        fs.accessSync(path.dirname(AUTH_PATH), fs.constants.W_OK)
      } catch {
        readonly = true
      }
      return
    }
    const raw = fs.readFileSync(AUTH_PATH, 'utf-8')
    const parsed = JSON.parse(raw)
    file = validateAuthFile(parsed) ? parsed : {}
    try {
      fs.accessSync(AUTH_PATH, fs.constants.W_OK)
      readonly = false
    } catch {
      readonly = true
    }
  } catch (err) {
    console.warn('ezbase: failed to load auth.json:', err)
    file = {}
  }
}

export function validateAuthFile(value: unknown): value is AuthFile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  if (v.publicUrl !== undefined && typeof v.publicUrl !== 'string') return false
  if (v.extraOrigins !== undefined) {
    if (!Array.isArray(v.extraOrigins) || v.extraOrigins.some((o) => typeof o !== 'string')) return false
  }
  if (v.providers !== undefined) {
    if (typeof v.providers !== 'object' || v.providers === null || Array.isArray(v.providers)) return false
    for (const [k, cred] of Object.entries(v.providers as Record<string, unknown>)) {
      if (!(PROVIDERS as readonly string[]).includes(k)) return false
      if (cred === null) continue
      if (typeof cred !== 'object' || cred === null) return false
      const c = cred as Record<string, unknown>
      if (typeof c.clientId !== 'string' || typeof c.clientSecret !== 'string') return false
    }
  }
  return true
}

loadFromDisk()

export function peekAuthPublicUrl(): string | undefined {
  return file.publicUrl || undefined
}

export function isAuthSettingsReadonly(): boolean {
  return readonly
}

export function getAuthFile(): AuthFile {
  return file
}

export function getEffectiveAuth(): EffectiveAuth {
  const publicUrl = (file.publicUrl || process.env.EZBASE_URL || defaultPublicUrl()).replace(/\/$/, '')
  const extraOrigins = unique(file.extraOrigins || []).filter((o) => o !== originOf(publicUrl))

  const providers = {} as Record<ProviderId, EffectiveProvider>
  for (const id of PROVIDERS) {
    const fromFile = file.providers?.[id]
    if (fromFile?.clientId && fromFile.clientSecret) {
      providers[id] = { ...fromFile, enabled: true }
    } else {
      providers[id] = { enabled: false, clientId: '', clientSecret: '' }
    }
  }

  return {
    publicUrl,
    extraOrigins,
    trustedOrigins: unique([originOf(publicUrl), ...extraOrigins]),
    providers,
  }
}

export function toView(cfg: EffectiveAuth): AuthSettingsView {
  const providers = {} as Record<ProviderId, ProviderView>
  for (const id of PROVIDERS) {
    const p = cfg.providers[id]
    providers[id] = {
      enabled: p.enabled,
      clientId: p.clientId,
      clientSecretSet: Boolean(p.clientSecret),
    }
  }
  return {
    publicUrl: cfg.publicUrl,
    extraOrigins: cfg.extraOrigins,
    callbackBase: `${cfg.publicUrl}/api/auth/callback`,
    providers,
    emailPassword: true,
    readonly,
  }
}

export type AuthSettingsPut = {
  publicUrl?: string
  extraOrigins?: string[]
  providers?: Partial<Record<ProviderId, { clientId: string; clientSecret?: string; enabled: boolean } | null>>
}

export function applyPut(body: AuthSettingsPut): AuthFile {
  const current = getEffectiveAuth()
  const next: AuthFile = {
    publicUrl: typeof body.publicUrl === 'string' ? body.publicUrl.replace(/\/$/, '') : current.publicUrl,
    extraOrigins: Array.isArray(body.extraOrigins)
      ? unique(body.extraOrigins.map((s) => originOf(s.trim())).filter(Boolean))
      : current.extraOrigins,
    providers: { ...(file.providers || {}) },
  }

  if (body.providers) {
    for (const id of PROVIDERS) {
      if (!(id in body.providers)) continue
      const incoming = body.providers[id]
      if (incoming === undefined) continue
      if (incoming === null || incoming.enabled === false) {
        next.providers![id] = null
        continue
      }
      const existing = current.providers[id]
      const clientId = incoming.clientId.trim() || existing.clientId
      const clientSecret = incoming.clientSecret?.trim() || existing.clientSecret
      if (!clientId || !clientSecret) {
        throw new Error(`${id}: client ID and secret are required to enable`)
      }
      next.providers![id] = { clientId, clientSecret }
    }
  }

  return next
}

export function writeAuthFile(next: AuthFile): void {
  if (readonly) throw new Error('auth.json is read-only')
  fs.mkdirSync(path.dirname(AUTH_PATH), { recursive: true })
  fs.writeFileSync(AUTH_PATH, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  file = next
}

export function watchAuthSettings(onChange: () => void): void {
  try {
    let debounce: ReturnType<typeof setTimeout> | null = null
    const dir = path.dirname(AUTH_PATH)
    fs.mkdirSync(dir, { recursive: true })
    fs.watch(dir, (_event, filename) => {
      if (filename && filename !== path.basename(AUTH_PATH)) return
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => {
        loadFromDisk()
        onChange()
      }, 200)
    })
  } catch {
    // no hot-reload
  }
}

function unique(items: string[]): string[] {
  return [...new Set(items)]
}

export { AUTH_PATH }
