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
  name?: string
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
      throw new Error(`${this.ez['_errorPrefix']}: ${body.error || body.message || res.statusText}`)
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
      throw new Error(`${this.ez['_errorPrefix']}: ${body.error || body.message || res.statusText}`)
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

// ── Database reference ────────────────────────────────────────
class DatabaseRef {
  constructor(
    private ez: EzBase,
    private name: string
  ) {}

  /** @internal — base path for API calls to this database */
  _basePath(): string {
    if (this.name === 'default') return `${this.ez._getUrl()}/api`
    return `${this.ez._getUrl()}/api/db/${encodeURIComponent(this.name)}`
  }

  collection<T = Record<string, unknown>>(name: string): CollectionRef<T> {
    return new CollectionRef<T>(this.ez, this, name)
  }

  async listCollections(): Promise<string[]> {
    const res = await fetch(`${this._basePath()}/collections`, {
      headers: this.ez._authHeaders(),
    })
    if (!res.ok) throw new Error(`${this.ez['_errorPrefix']}: ${res.status} ${await res.text()}`)
    return res.json()
  }

  async getPermission(collection: string): Promise<{ database: string; collection: string; level: string }> {
    const res = await fetch(
      `${this._basePath()}/collections/${encodeURIComponent(collection)}/permissions`,
      { headers: this.ez._authHeaders() }
    )
    if (!res.ok) throw new Error(`${this.ez['_errorPrefix']}: ${res.status} ${await res.text()}`)
    return res.json()
  }

  async setPermission(collection: string, level: string): Promise<{ database: string; collection: string; level: string }> {
    const res = await fetch(
      `${this._basePath()}/collections/${encodeURIComponent(collection)}/permissions`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...this.ez._authHeaders() },
        body: JSON.stringify({ level }),
      }
    )
    if (!res.ok) throw new Error(`${this.ez['_errorPrefix']}: ${res.status} ${await res.text()}`)
    return res.json()
  }
}

// ── EzBase client ─────────────────────────────────────────────
class EzBase {
  private url: string
  private adminKey?: string
  private _name: string
  private _defaultDb: DatabaseRef
  readonly auth: AuthClient

  /** @internal */
  get _errorPrefix(): string {
    return `ezbase [${this._name}]`
  }

  constructor(urlOrOpts: string | EzBaseOptions) {
    if (typeof urlOrOpts === 'string') {
      this.url = urlOrOpts.replace(/\/$/, '')
      this._name = 'default'
    } else {
      this.url = urlOrOpts.url.replace(/\/$/, '')
      this.adminKey = urlOrOpts.adminKey
      this._name = urlOrOpts.name || 'default'
    }
    this.auth = new AuthClient(this)
    this._defaultDb = new DatabaseRef(this, 'default')
  }

  database(name: string): DatabaseRef {
    return new DatabaseRef(this, name)
  }

  collection<T = Record<string, unknown>>(name: string): CollectionRef<T> {
    return this._defaultDb.collection<T>(name)
  }

  async listDatabases(): Promise<string[]> {
    const res = await fetch(`${this.url}/api/databases`, {
      headers: this._authHeaders(),
    })
    if (!res.ok) throw new Error(`${this._errorPrefix}: ${res.status} ${await res.text()}`)
    return res.json()
  }

  async listCollections(): Promise<string[]> {
    return this._defaultDb.listCollections()
  }

  async getPermission(collection: string) {
    return this._defaultDb.getPermission(collection)
  }

  async setPermission(collection: string, level: string) {
    return this._defaultDb.setPermission(collection, level)
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
    private db: DatabaseRef,
    private name: string
  ) {}

  private _basePath(): string {
    return `${this.db._basePath()}/collections/${encodeURIComponent(this.name)}`
  }

  doc(id: string): DocRef<T> {
    return new DocRef<T>(this.ez, this.db, this.name, id)
  }

  where(field: string, op: WhereOp, value: unknown): QueryRef<T> {
    return new QueryRef<T>(this.ez, this.db, this.name).where(field, op, value)
  }

  orderBy(field: string, direction?: OrderDir): QueryRef<T> {
    return new QueryRef<T>(this.ez, this.db, this.name).orderBy(field, direction)
  }

  limit(n: number): QueryRef<T> {
    return new QueryRef<T>(this.ez, this.db, this.name).limit(n)
  }

  async add(data: Partial<T>): Promise<Document<T>> {
    const res = await fetch(this._basePath(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.ez._authHeaders() },
      body: JSON.stringify(data),
    })
    if (!res.ok) throw new Error(`${this.ez['_errorPrefix']}: ${res.status} ${await res.text()}`)
    return res.json()
  }

  async get(): Promise<Document<T>[]> {
    const res = await fetch(this._basePath(), { headers: this.ez._authHeaders() })
    if (!res.ok) throw new Error(`${this.ez['_errorPrefix']}: ${res.status} ${await res.text()}`)
    return res.json()
  }

  onSnapshot(
    callback: (docs: Document<T>[]) => void,
    onError?: (err: Error) => void
  ): () => void {
    const tp = this.ez._sseTokenParam()
    const sep = tp ? '?' : ''
    const url = `${this._basePath()}/sse${sep}${tp}`
    return sseConnect(url, this.ez._authHeaders(), (data) => callback(JSON.parse(data)), onError)
  }
}

// ── Document reference ────────────────────────────────────────
class DocRef<T = Record<string, unknown>> {
  constructor(
    private ez: EzBase,
    private db: DatabaseRef,
    private collection: string,
    private id: string
  ) {}

  private path(): string {
    return `${this.db._basePath()}/collections/${encodeURIComponent(this.collection)}/${encodeURIComponent(this.id)}`
  }

  async get(): Promise<Document<T> | null> {
    const res = await fetch(this.path(), { headers: this.ez._authHeaders() })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`${this.ez['_errorPrefix']}: ${res.status} ${await res.text()}`)
    return res.json()
  }

  async set(data: T): Promise<Document<T>> {
    const res = await fetch(this.path(), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...this.ez._authHeaders() },
      body: JSON.stringify(data),
    })
    if (!res.ok) throw new Error(`${this.ez['_errorPrefix']}: ${res.status} ${await res.text()}`)
    return res.json()
  }

  async update(data: Partial<T>): Promise<Document<T>> {
    const res = await fetch(this.path(), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...this.ez._authHeaders() },
      body: JSON.stringify(data),
    })
    if (!res.ok) throw new Error(`${this.ez['_errorPrefix']}: ${res.status} ${await res.text()}`)
    return res.json()
  }

  async delete(): Promise<void> {
    const res = await fetch(this.path(), {
      method: 'DELETE',
      headers: this.ez._authHeaders(),
    })
    if (!res.ok) throw new Error(`${this.ez['_errorPrefix']}: ${res.status} ${await res.text()}`)
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
    private db: DatabaseRef,
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

  private _basePath(): string {
    return `${this.db._basePath()}/collections/${encodeURIComponent(this.collection)}`
  }

  async get(): Promise<Document<T>[]> {
    const url = `${this._basePath()}${this.buildParams()}`
    const res = await fetch(url, { headers: this.ez._authHeaders() })
    if (!res.ok) throw new Error(`${this.ez['_errorPrefix']}: ${res.status} ${await res.text()}`)
    return res.json()
  }

  onSnapshot(
    callback: (docs: Document<T>[]) => void,
    onError?: (err: Error) => void
  ): () => void {
    const base = `${this._basePath()}/sse${this.buildParams()}`
    const tp = this.ez._sseTokenParam()
    const sep = base.includes('?') ? '&' : '?'
    const url = tp ? `${base}${sep}${tp}` : base
    return sseConnect(url, this.ez._authHeaders(), (data) => callback(JSON.parse(data)), onError)
  }
}

export { EzBase, DatabaseRef, CollectionRef, DocRef, QueryRef, AuthClient }
export type { Document, WhereOp, OrderDir, EzBaseOptions, AuthUser }
export default EzBase
