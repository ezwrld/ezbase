type WhereOp = '==' | '!=' | '<' | '>' | '<=' | '>='
type WhereClause = [string, WhereOp, unknown]
type OrderDir = 'asc' | 'desc'

interface Document<T = Record<string, unknown>> {
  id: string
  data: T
  created: number
  updated: number
}

interface EzBaseOptions {
  url: string
  adminKey?: string
}

interface AuthUser {
  id: string
  email: string
  role: string
  created?: number
  updated?: number
}

type AuthStateCallback = (user: AuthUser | null) => void

// ── SSE helper (works in Node 18+, browsers, Deno, Bun) ──────
function sseConnect(
  url: string,
  headers: Record<string, string>,
  onSnapshot: (data: string) => void,
  onError?: (err: Error) => void
): () => void {
  const controller = new AbortController()

  ;(async () => {
    try {
      const res = await fetch(url, {
        headers: { Accept: 'text/event-stream', ...headers },
        signal: controller.signal,
      })

      if (!res.ok || !res.body) {
        throw new Error(`SSE connect failed: ${res.status}`)
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let eventType = ''
      let dataLines: string[] = []

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop()!

        for (const line of lines) {
          if (line.startsWith('event:')) {
            eventType = line.slice(6).trim()
          } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trim())
          } else if (line === '' || line === '\r') {
            if (eventType === 'snapshot' && dataLines.length > 0) {
              onSnapshot(dataLines.join('\n'))
            }
            eventType = ''
            dataLines = []
          }
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== 'AbortError') {
        onError?.(err)
      }
    }
  })()

  return () => controller.abort()
}

// ── Auth client ───────────────────────────────────────────────
class AuthClient {
  private _token: string | null = null
  private _currentUser: AuthUser | null = null
  private _listeners = new Set<AuthStateCallback>()

  constructor(private ez: EzBase) {}

  get currentUser(): AuthUser | null {
    return this._currentUser
  }

  /** @internal */
  _getToken(): string | null {
    return this._token
  }

  async signUp(opts: { email: string; password: string }): Promise<{ token: string; user: AuthUser }> {
    const res = await fetch(`${this.ez['url']}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.ez['_authHeaders']() },
      body: JSON.stringify({ email: opts.email, password: opts.password, name: opts.email }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }))
      throw new Error(`ezbase: ${body.error || body.message || res.statusText}`)
    }
    const data = await res.json()
    this._token = data.session?.token || data.token
    this._currentUser = {
      id: data.user?.id || data.id,
      email: data.user?.email || data.email,
      role: data.user?.role || 'user',
    }
    this._notify()
    return { token: this._token!, user: this._currentUser! }
  }

  async signIn(opts: { email: string; password: string }): Promise<{ token: string; user: AuthUser }> {
    const res = await fetch(`${this.ez['url']}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.ez['_authHeaders']() },
      body: JSON.stringify({ email: opts.email, password: opts.password }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }))
      throw new Error(`ezbase: ${body.error || body.message || res.statusText}`)
    }
    const data = await res.json()
    this._token = data.session?.token || data.token
    this._currentUser = {
      id: data.user?.id || data.id,
      email: data.user?.email || data.email,
      role: data.user?.role || 'user',
    }
    this._notify()
    return { token: this._token!, user: this._currentUser! }
  }

  async signOut() {
    // Fire-and-forget server-side sign out
    if (this._token) {
      fetch(`${this.ez['url']}/api/auth/sign-out`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.ez['_authHeaders']() },
      }).catch(() => {})
    }
    this._token = null
    this._currentUser = null
    this._notify()
  }

  restoreSession(token: string, user: AuthUser) {
    this._token = token
    this._currentUser = user
    this._notify()
  }

  onAuthStateChanged(callback: AuthStateCallback): () => void {
    this._listeners.add(callback)
    return () => { this._listeners.delete(callback) }
  }

  private _notify() {
    for (const cb of this._listeners) {
      try { cb(this._currentUser) } catch {}
    }
  }
}

// ── EzBase client ─────────────────────────────────────────────
class EzBase {
  private url: string
  private adminKey?: string
  readonly auth: AuthClient

  constructor(urlOrOpts: string | EzBaseOptions) {
    if (typeof urlOrOpts === 'string') {
      this.url = urlOrOpts.replace(/\/$/, '')
    } else {
      this.url = urlOrOpts.url.replace(/\/$/, '')
      this.adminKey = urlOrOpts.adminKey
    }
    this.auth = new AuthClient(this)
  }

  collection<T = Record<string, unknown>>(name: string): CollectionRef<T> {
    return new CollectionRef<T>(this, name)
  }

  /** @internal */
  _getUrl(): string {
    return this.url
  }

  /** @internal */
  _authHeaders(): Record<string, string> {
    const token = this.adminKey || this.auth._getToken()
    if (token) return { Authorization: `Bearer ${token}` }
    return {}
  }

  /** @internal — append token as query param for SSE (EventSource can't send headers) */
  _sseTokenParam(): string {
    const token = this.adminKey || this.auth._getToken()
    if (token) return `token=${encodeURIComponent(token)}`
    return ''
  }
}

// ── Collection reference ──────────────────────────────────────
class CollectionRef<T = Record<string, unknown>> {
  constructor(
    private ez: EzBase,
    private name: string
  ) {}

  doc(id: string): DocRef<T> {
    return new DocRef<T>(this.ez, this.name, id)
  }

  where(field: string, op: WhereOp, value: unknown): QueryRef<T> {
    return new QueryRef<T>(this.ez, this.name).where(field, op, value)
  }

  orderBy(field: string, direction?: OrderDir): QueryRef<T> {
    return new QueryRef<T>(this.ez, this.name).orderBy(field, direction)
  }

  limit(n: number): QueryRef<T> {
    return new QueryRef<T>(this.ez, this.name).limit(n)
  }

  async add(data: Partial<T>): Promise<Document<T>> {
    const res = await fetch(
      `${this.ez._getUrl()}/api/collections/${encodeURIComponent(this.name)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.ez._authHeaders() },
        body: JSON.stringify(data),
      }
    )
    if (!res.ok) throw new Error(`ezbase: ${res.status} ${await res.text()}`)
    return res.json()
  }

  async get(): Promise<Document<T>[]> {
    const res = await fetch(
      `${this.ez._getUrl()}/api/collections/${encodeURIComponent(this.name)}`,
      { headers: this.ez._authHeaders() }
    )
    if (!res.ok) throw new Error(`ezbase: ${res.status} ${await res.text()}`)
    return res.json()
  }

  onSnapshot(
    callback: (docs: Document<T>[]) => void,
    onError?: (err: Error) => void
  ): () => void {
    const tp = this.ez._sseTokenParam()
    const sep = tp ? '?' : ''
    const url = `${this.ez._getUrl()}/api/collections/${encodeURIComponent(this.name)}/sse${sep}${tp}`
    return sseConnect(url, this.ez._authHeaders(), (data) => callback(JSON.parse(data)), onError)
  }
}

// ── Document reference ────────────────────────────────────────
class DocRef<T = Record<string, unknown>> {
  constructor(
    private ez: EzBase,
    private collection: string,
    private id: string
  ) {}

  private path(): string {
    return `${this.ez._getUrl()}/api/collections/${encodeURIComponent(this.collection)}/${encodeURIComponent(this.id)}`
  }

  async get(): Promise<Document<T> | null> {
    const res = await fetch(this.path(), { headers: this.ez._authHeaders() })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`ezbase: ${res.status} ${await res.text()}`)
    return res.json()
  }

  async set(data: T): Promise<Document<T>> {
    const res = await fetch(this.path(), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...this.ez._authHeaders() },
      body: JSON.stringify(data),
    })
    if (!res.ok) throw new Error(`ezbase: ${res.status} ${await res.text()}`)
    return res.json()
  }

  async update(data: Partial<T>): Promise<Document<T>> {
    const res = await fetch(this.path(), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...this.ez._authHeaders() },
      body: JSON.stringify(data),
    })
    if (!res.ok) throw new Error(`ezbase: ${res.status} ${await res.text()}`)
    return res.json()
  }

  async delete(): Promise<void> {
    const res = await fetch(this.path(), {
      method: 'DELETE',
      headers: this.ez._authHeaders(),
    })
    if (!res.ok) throw new Error(`ezbase: ${res.status} ${await res.text()}`)
  }

  onSnapshot(
    callback: (doc: Document<T> | null) => void,
    onError?: (err: Error) => void
  ): () => void {
    const tp = this.ez._sseTokenParam()
    const sep = tp ? '?' : ''
    const url = `${this.path()}/sse${sep}${tp}`
    return sseConnect(url, this.ez._authHeaders(), (data) => callback(JSON.parse(data)), onError)
  }
}

// ── Query reference (chainable) ──────────────────────────────
class QueryRef<T = Record<string, unknown>> {
  private wheres: WhereClause[] = []
  private _orderBy?: string
  private _order?: OrderDir
  private _limit?: number

  constructor(
    private ez: EzBase,
    private collection: string
  ) {}

  where(field: string, op: WhereOp, value: unknown): this {
    this.wheres.push([field, op, value])
    return this
  }

  orderBy(field: string, direction: OrderDir = 'asc'): this {
    this._orderBy = field
    this._order = direction
    return this
  }

  limit(n: number): this {
    this._limit = n
    return this
  }

  private buildParams(): string {
    const params = new URLSearchParams()
    if (this.wheres.length > 0) {
      params.set('where', JSON.stringify(this.wheres))
    }
    if (this._orderBy) {
      params.set('orderBy', this._orderBy)
      if (this._order) params.set('order', this._order)
    }
    if (this._limit !== undefined) {
      params.set('limit', String(this._limit))
    }
    const qs = params.toString()
    return qs ? '?' + qs : ''
  }

  async get(): Promise<Document<T>[]> {
    const url = `${this.ez._getUrl()}/api/collections/${encodeURIComponent(this.collection)}${this.buildParams()}`
    const res = await fetch(url, { headers: this.ez._authHeaders() })
    if (!res.ok) throw new Error(`ezbase: ${res.status} ${await res.text()}`)
    return res.json()
  }

  onSnapshot(
    callback: (docs: Document<T>[]) => void,
    onError?: (err: Error) => void
  ): () => void {
    const base = `${this.ez._getUrl()}/api/collections/${encodeURIComponent(this.collection)}/sse${this.buildParams()}`
    const tp = this.ez._sseTokenParam()
    const sep = base.includes('?') ? '&' : '?'
    const url = tp ? `${base}${sep}${tp}` : base
    return sseConnect(url, this.ez._authHeaders(), (data) => callback(JSON.parse(data)), onError)
  }
}

export { EzBase, CollectionRef, DocRef, QueryRef, AuthClient }
export type { Document, WhereOp, OrderDir, EzBaseOptions, AuthUser }
export default EzBase
