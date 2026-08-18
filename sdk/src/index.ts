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

// ── Rules types ──────────────────────────────────────────────
interface FilterMap { [docField: string]: string }
interface CollectionRule { access: string; filter?: FilterMap }
interface ReadWriteRule { read?: string | CollectionRule; write?: string | CollectionRule }
type RuleValue = string | CollectionRule | ReadWriteRule
interface RulesFile { default: string | { read?: string; write?: string }; collections?: Record<string, RuleValue>; buckets?: Record<string, string> }
interface RulesResponse { rules: RulesFile; readonly: boolean }

interface AuthUser {
  id: string
  email: string
  role: string
  claims: Record<string, unknown>
  name?: string
  image?: string
  created?: number
  updated?: number
}

interface FileMeta {
  path: string
  bucket: string
  filename: string
  size: number
  mimeType: string
  uploadedBy: string | null
  created: number
  updated: number
  url: string
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
      if (!controller.signal.aborted) {
        onError?.(new Error('SSE connection closed'))
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
    const u = data.user || data
    this._currentUser = {
      id: u.id,
      email: u.email,
      role: u.role || 'user',
      claims: typeof u.claims === 'string' ? JSON.parse(u.claims || '{}') : (u.claims || {}),
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
    const u = data.user || data
    this._currentUser = {
      id: u.id,
      email: u.email,
      role: u.role || 'user',
      claims: typeof u.claims === 'string' ? JSON.parse(u.claims || '{}') : (u.claims || {}),
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

  async signInWithProvider(
    provider: string,
    opts?: { callbackURL?: string; newUserCallbackURL?: string; errorCallbackURL?: string }
  ): Promise<void> {
    const params = new URLSearchParams()
    params.set('callbackURL', opts?.callbackURL || '/')
    if (opts?.newUserCallbackURL) params.set('newUserCallbackURL', opts.newUserCallbackURL)
    if (opts?.errorCallbackURL) params.set('errorCallbackURL', opts.errorCallbackURL)
    const url = `${this.ez['url']}/api/auth/sign-in/social?${params}`

    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider, callbackURL: opts?.callbackURL || '/', ...(opts?.newUserCallbackURL && { newUserCallbackURL: opts.newUserCallbackURL }), ...(opts?.errorCallbackURL && { errorCallbackURL: opts.errorCallbackURL }) }), redirect: 'manual' })
    const location = res.headers.get('location')
    if (location) {
      if (typeof window !== 'undefined') {
        window.location.href = location
      }
      return
    }

    // Some BetterAuth versions return JSON with url instead of redirect
    if (res.ok) {
      const data = await res.json().catch(() => null)
      if (data?.url) {
        if (typeof window !== 'undefined') {
          window.location.href = data.url
        }
        return
      }
    }

    throw new Error(`${this.ez['_errorPrefix']}: OAuth sign-in failed for provider '${provider}'`)
  }

  async getSession(): Promise<{ token: string; user: AuthUser } | null> {
    const res = await fetch(`${this.ez['url']}/api/auth/get-session`, {
      credentials: 'include',
      headers: this.ez['_authHeaders'](),
    })
    if (!res.ok) return null
    const data = await res.json()
    if (!data?.session?.token || !data?.user) return null

    this._token = data.session.token
    this._currentUser = {
      id: data.user.id,
      email: data.user.email,
      role: data.user.role || 'user',
      claims: typeof data.user.claims === 'string' ? JSON.parse(data.user.claims || '{}') : (data.user.claims || {}),
      ...(data.user.name && { name: data.user.name }),
      ...(data.user.image && { image: data.user.image }),
    }
    this._notify()
    return { token: this._token!, user: this._currentUser! }
  }

  async listProviders(): Promise<{ providers: string[]; emailPassword: boolean }> {
    const res = await fetch(`${this.ez['url']}/api/auth/providers`)
    if (!res.ok) throw new Error(`${this.ez['_errorPrefix']}: failed to list providers`)
    return res.json()
  }

  // ── Password management ────────────────────────────────────

  /**
   * Email a password-reset link (requires SMTP on the server; without SMTP the
   * link is printed to server logs). `redirectTo` is the page in YOUR app the
   * link lands on — it receives ?token=..., which you pass to resetPassword().
   */
  async requestPasswordReset(email: string, redirectTo?: string): Promise<void> {
    const res = await fetch(`${this.ez['url']}/api/auth/request-password-reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, ...(redirectTo ? { redirectTo } : {}) }),
    })
    if (!res.ok) throw new Error(`${this.ez['_errorPrefix']}: ${res.status} ${await res.text()}`)
  }

  /** Complete a password reset with the token from the emailed link */
  async resetPassword(newPassword: string, token: string): Promise<void> {
    const res = await fetch(`${this.ez['url']}/api/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newPassword, token }),
    })
    if (!res.ok) throw new Error(`${this.ez['_errorPrefix']}: ${res.status} ${await res.text()}`)
  }

  /** Change the signed-in user's password */
  async changePassword(currentPassword: string, newPassword: string, opts?: { revokeOtherSessions?: boolean }): Promise<void> {
    const res = await fetch(`${this.ez['url']}/api/auth/change-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.ez._authHeaders() },
      body: JSON.stringify({
        currentPassword,
        newPassword,
        revokeOtherSessions: opts?.revokeOtherSessions ?? true,
      }),
    })
    if (!res.ok) throw new Error(`${this.ez['_errorPrefix']}: ${res.status} ${await res.text()}`)
  }

  // ── Admin user management ──────────────────────────────────

  async listUsers(opts?: { limit?: number; offset?: number }): Promise<AuthUser[]> {
    const params = new URLSearchParams()
    if (opts?.limit !== undefined) params.set('limit', String(opts.limit))
    if (opts?.offset !== undefined) params.set('offset', String(opts.offset))
    const qs = params.toString()
    const res = await fetch(`${this.ez['url']}/api/auth/users${qs ? '?' + qs : ''}`, {
      headers: this.ez._authHeaders(),
    })
    if (!res.ok) throw new Error(`${this.ez['_errorPrefix']}: ${res.status} ${await res.text()}`)
    return res.json()
  }

  async getUser(id: string): Promise<AuthUser> {
    const res = await fetch(`${this.ez['url']}/api/auth/users/${encodeURIComponent(id)}`, {
      headers: this.ez._authHeaders(),
    })
    if (!res.ok) throw new Error(`${this.ez['_errorPrefix']}: ${res.status} ${await res.text()}`)
    return res.json()
  }

  /** Admin: set a user's password directly (revokes their sessions). Works without SMTP. */
  async setPassword(userId: string, password: string): Promise<void> {
    const res = await fetch(`${this.ez['url']}/api/auth/users/${encodeURIComponent(userId)}/password`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...this.ez._authHeaders() },
      body: JSON.stringify({ password }),
    })
    if (!res.ok) throw new Error(`${this.ez['_errorPrefix']}: ${res.status} ${await res.text()}`)
  }

  async setRole(userId: string, role: string): Promise<AuthUser> {
    const res = await fetch(`${this.ez['url']}/api/auth/users/${encodeURIComponent(userId)}/role`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...this.ez._authHeaders() },
      body: JSON.stringify({ role }),
    })
    if (!res.ok) throw new Error(`${this.ez['_errorPrefix']}: ${res.status} ${await res.text()}`)
    return res.json()
  }

  async setClaims(userId: string, claims: Record<string, unknown>): Promise<AuthUser> {
    const res = await fetch(`${this.ez['url']}/api/auth/users/${encodeURIComponent(userId)}/claims`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...this.ez._authHeaders() },
      body: JSON.stringify(claims),
    })
    if (!res.ok) throw new Error(`${this.ez['_errorPrefix']}: ${res.status} ${await res.text()}`)
    return res.json()
  }

  async mergeClaims(userId: string, claims: Record<string, unknown>): Promise<AuthUser> {
    const res = await fetch(`${this.ez['url']}/api/auth/users/${encodeURIComponent(userId)}/claims`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...this.ez._authHeaders() },
      body: JSON.stringify(claims),
    })
    if (!res.ok) throw new Error(`${this.ez['_errorPrefix']}: ${res.status} ${await res.text()}`)
    return res.json()
  }

  async deleteUser(userId: string): Promise<void> {
    const res = await fetch(`${this.ez['url']}/api/auth/users/${encodeURIComponent(userId)}`, {
      method: 'DELETE',
      headers: this.ez._authHeaders(),
    })
    if (!res.ok) throw new Error(`${this.ez['_errorPrefix']}: ${res.status} ${await res.text()}`)
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

  async setPermission(collection: string, level: string | CollectionRule): Promise<{ database: string; collection: string; level: string }> {
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

  storage(bucket: string): StorageBucket {
    return new StorageBucket(this, bucket)
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

  async setPermission(collection: string, level: string | CollectionRule) {
    return this._defaultDb.setPermission(collection, level)
  }

  async getRules(): Promise<RulesResponse> {
    const res = await fetch(`${this.url}/api/rules`, {
      headers: this._authHeaders(),
    })
    if (!res.ok) throw new Error(`${this._errorPrefix}: ${res.status} ${await res.text()}`)
    return res.json()
  }

  async setRules(rules: RulesFile): Promise<RulesResponse> {
    const res = await fetch(`${this.url}/api/rules`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...this._authHeaders() },
      body: JSON.stringify(rules),
    })
    if (!res.ok) throw new Error(`${this._errorPrefix}: ${res.status} ${await res.text()}`)
    return res.json()
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

  select<K extends Extract<keyof T, string>>(...fields: K[]): QueryRef<T, Pick<T, K>> {
    return new QueryRef<T>(this.ez, this.db, this.name).select(...fields)
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
    return sseConnect(`${this._basePath()}/sse`, this.ez._authHeaders(), (data) => callback(JSON.parse(data)), onError)
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
    return sseConnect(`${this.path()}/sse`, this.ez._authHeaders(), (data) => callback(JSON.parse(data)), onError)
  }
}

// ── Storage ────────────────────────────────────────────────────
class StorageBucket {
  constructor(private ez: EzBase, private bucket: string) {}

  file(path: string): FileHandle {
    return new FileHandle(this.ez, this.bucket, path)
  }

  async upload(pathOrFile: string | File | Blob, file?: File | Blob): Promise<FileMeta> {
    const formData = new FormData()
    let url: string

    if (typeof pathOrFile === 'string' && file) {
      formData.append('file', file)
      url = `${this.ez._getUrl()}/api/storage/${encodeURIComponent(this.bucket)}/${pathOrFile}`
    } else {
      formData.append('file', pathOrFile as File | Blob)
      url = `${this.ez._getUrl()}/api/storage/${encodeURIComponent(this.bucket)}`
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: this.ez._authHeaders(),
      body: formData,
    })
    if (!res.ok) throw new Error(`${this.ez._errorPrefix}: ${res.status} ${await res.text()}`)
    return res.json()
  }

  async list(): Promise<FileMeta[]> {
    const res = await fetch(
      `${this.ez._getUrl()}/api/storage/${encodeURIComponent(this.bucket)}`,
      { headers: this.ez._authHeaders() }
    )
    if (!res.ok) throw new Error(`${this.ez._errorPrefix}: ${res.status} ${await res.text()}`)
    return res.json()
  }
}

class FileHandle {
  constructor(private ez: EzBase, private bucket: string, private path: string) {}

  get url(): string {
    return `${this.ez._getUrl()}/api/storage/${encodeURIComponent(this.bucket)}/${this.path}`
  }

  async download(): Promise<Blob> {
    const res = await fetch(this.url, { headers: this.ez._authHeaders() })
    if (!res.ok) throw new Error(`${this.ez._errorPrefix}: ${res.status}`)
    return res.blob()
  }

  async delete(): Promise<void> {
    const res = await fetch(this.url, { method: 'DELETE', headers: this.ez._authHeaders() })
    if (!res.ok) throw new Error(`${this.ez._errorPrefix}: ${res.status} ${await res.text()}`)
  }
}

// ── Query reference (chainable) ──────────────────────────────
class QueryRef<T = Record<string, unknown>, Result = T> {
  private wheres: WhereClause[] = []
  private _orderBy?: string
  private _order?: OrderDir
  private _limit?: number
  private _fields?: string[]

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

  select<K extends Extract<keyof T, string>>(...fields: K[]): QueryRef<T, Pick<T, K>> {
    if (fields.length === 0) throw new Error('select() requires at least one field')
    this._fields = Array.from(new Set(fields))
    return this as unknown as QueryRef<T, Pick<T, K>>
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
    if (this._fields) {
      params.set('fields', this._fields.join(','))
    }
    const qs = params.toString()
    return qs ? '?' + qs : ''
  }

  private _basePath(): string {
    return `${this.db._basePath()}/collections/${encodeURIComponent(this.collection)}`
  }

  async get(): Promise<Document<Result>[]> {
    const url = `${this._basePath()}${this.buildParams()}`
    const res = await fetch(url, { headers: this.ez._authHeaders() })
    if (!res.ok) throw new Error(`${this.ez['_errorPrefix']}: ${res.status} ${await res.text()}`)
    return res.json()
  }

  onSnapshot(
    callback: (docs: Document<Result>[]) => void,
    onError?: (err: Error) => void
  ): () => void {
    const url = `${this._basePath()}/sse${this.buildParams()}`
    return sseConnect(url, this.ez._authHeaders(), (data) => callback(JSON.parse(data)), onError)
  }
}

export { EzBase, DatabaseRef, CollectionRef, DocRef, QueryRef, AuthClient, StorageBucket, FileHandle }
export type { Document, WhereOp, OrderDir, EzBaseOptions, AuthUser, FileMeta, RulesFile, CollectionRule, FilterMap, RulesResponse, RuleValue, ReadWriteRule }
export default EzBase
