# ezbase — SDK & Integration Reference

> The canonical reference for building with ezbase. If you're a coding agent or developer integrating ezbase into a project, this is the only file you need.

## What is ezbase?

A self-hosted document database. One Docker image, one port, zero config. Think Firebase but self-hosted.

ezbase is a **DX wrapper**, not a database engine. Under the hood:

- **Postgres** — document storage (JSONB per-collection tables with GIN indexes), pub/sub (LISTEN/NOTIFY), auth storage
- **BetterAuth** — email/password authentication, session tokens
- **Hono** — REST API framework (runs on Bun)
- **Nginx** — reverse proxy, serves console UI, single port (7003)

No SQL, no migrations, no ORMs. You interact through the SDK or REST API.

## Setup

### 1. Add ezbase to your Docker Compose

```yaml
services:
  ezbase:
    image: ghcr.io/ezwrld/ezbase:latest
    ports:
      - "7003:7003"
    volumes:
      - ezbase-data:/data

volumes:
  ezbase-data:
```

Zero config — just start it. One service, one port (7003), one volume (`/data`). Console UI at `http://localhost:7003/console`.

```bash
# Get your auto-generated admin key from the logs
docker compose logs ezbase | grep ADMIN_KEY

# Or set your own
environment:
  ADMIN_KEY: "my-secret-key"
```

### 2. Install the SDK

```bash
npm install @ezwrld/ezbase
```

Zero dependencies. Works in Node 18+, Bun, Deno, and browsers.

## SDK Reference

### Initialize

```typescript
import { EzBase } from '@ezwrld/ezbase'

// Client mode — respects collection permissions
const ez = new EzBase({ url: 'http://localhost:7003' })

// Admin mode — bypasses all permissions
const ez = new EzBase({
  url: 'http://localhost:7003',
  adminKey: 'your-secret-admin-key',
  name: 'production',  // optional label, shows in error messages
})
```

### Documents — CRUD

Collections are created automatically on first write. No setup needed.

```typescript
// Create
const doc = await ez.collection('todos').add({ title: 'Ship it', done: false })
// → { id: 'xk29f...', data: { title: 'Ship it', done: false }, created: 1709..., updated: 1709... }

// Get by ID (returns null if not found)
const doc = await ez.collection('todos').doc('xk29f...').get()

// List all
const docs = await ez.collection('todos').get()

// Update (merge — other fields preserved)
await ez.collection('todos').doc('xk29f...').update({ done: true })

// Replace (overwrite entire data, upsert — creates if missing)
await ez.collection('todos').doc('xk29f...').set({ title: 'New', status: 'replaced' })

// Delete
await ez.collection('todos').doc('xk29f...').delete()
```

### Document Shape

Every document returned by the SDK:

```typescript
{
  id: string       // auto-generated unique ID
  data: T          // your JSON data
  created: number  // Unix timestamp (ms)
  updated: number  // Unix timestamp (ms)
}
```

Your data goes inside `data`. When you call `.add({ title: 'foo' })`, the response is `{ id, data: { title: 'foo' }, created, updated }`.

### Queries

Chain `.where()`, `.orderBy()`, `.limit()` before `.get()`:

```typescript
// Filter
const active = await ez.collection('todos')
  .where('done', '==', false)
  .get()

// Multiple filters (AND)
const urgent = await ez.collection('todos')
  .where('done', '==', false)
  .where('priority', '>', 5)
  .get()

// Sort + limit
const recent = await ez.collection('todos')
  .orderBy('created', 'desc')
  .limit(10)
  .get()

// Full chain
const results = await ez.collection('todos')
  .where('done', '==', false)
  .orderBy('priority', 'desc')
  .limit(20)
  .get()
```

**Operators:** `==`, `!=`, `<`, `>`, `<=`, `>=`

**Sortable/filterable fields:** Any field in your data, plus `created` and `updated` (document timestamps).

### Real-Time (SSE)

Subscribe to changes. Callback fires immediately with current state, then on every change.

```typescript
// Collection — callback receives full array of docs
const unsub = ez.collection('todos').onSnapshot((docs) => {
  console.log('all todos:', docs)
})

// Single document — callback receives doc or null (if deleted)
const unsub = ez.collection('todos').doc('xk29f...').onSnapshot((doc) => {
  console.log('todo:', doc)
})

// Query — same as collection but filtered
const unsub = ez.collection('todos')
  .where('done', '==', false)
  .orderBy('created', 'desc')
  .onSnapshot((docs) => {
    console.log('active todos:', docs)
  })

// Stop listening
unsub()
```

Optional error handler as second argument:

```typescript
const unsub = ez.collection('todos').onSnapshot(
  (docs) => { /* data */ },
  (err) => { console.error('SSE error:', err) }
)
```

### Multiple Databases

One ezbase instance can have multiple databases. Each database is an isolated set of collections. Auth is shared across all databases.

Databases auto-create on first write, just like collections:

```typescript
// Default database — most projects only ever use this
await ez.collection('todos').add({ title: 'Ship it' })
// ↑ shorthand for ez.database('default').collection('todos')

// Named databases — isolated document stores, shared auth
const auburn = ez.database('auburn')
const oxford = ez.database('oxford')

await auburn.collection('orders').add({ customer: 'Alice', total: 250 })
await oxford.collection('orders').add({ customer: 'Bob', total: 180 })
// These are completely separate tables — no cross-contamination
```

Database names follow the same rules as collection names: `[a-zA-Z][a-zA-Z0-9_]{0,62}`.

### Admin Methods

Require admin key in the constructor:

```typescript
const ez = new EzBase({ url: '...', adminKey: '...' })

// List all databases
const dbs = await ez.listDatabases()  // ['default', 'auburn']

// List collections in a database
const cols = await ez.listCollections()  // default db
const cols2 = await ez.database('auburn').listCollections()

// Permission management
await ez.setPermission('todos', 'authenticated')             // default db
await ez.database('auburn').setPermission('orders', 'admin')  // named db
const perm = await ez.getPermission('todos')
// → { database: 'default', collection: 'todos', level: 'authenticated' }
```

### Auth

ezbase uses BetterAuth for authentication. Email/password works out of the box.

```typescript
// Sign up
const { token, user } = await ez.auth.signUp({
  email: 'alice@example.com',
  password: 'min8chars',
})

// Sign in
const { token, user } = await ez.auth.signIn({
  email: 'alice@example.com',
  password: 'min8chars',
})

// Current user — { id, email, role, claims } or null
const user = ez.auth.currentUser
// user.role    → "user" (default), "admin", "mover", etc.
// user.claims  → { orgId: "auburn", region: "southeast" }

// Sign out
await ez.auth.signOut()

// Watch auth state
const unsub = ez.auth.onAuthStateChanged((user) => {
  if (user) console.log('signed in as', user.email)
  else console.log('signed out')
})

// Restore from storage (e.g. on page load)
ez.auth.restoreSession(savedToken, savedUser)
```

After `signUp` or `signIn`, the SDK auto-attaches the session token to all requests. No manual header management.

### OAuth Providers

ezbase supports OAuth sign-in (Google, GitHub, Microsoft, Apple) via BetterAuth. Providers are enabled by setting env vars — no code changes to the server.

**Setup:**

1. Create an OAuth app with your provider (e.g. Google Cloud Console, GitHub Developer Settings)
2. Set the callback URL to `{your-ezbase-url}/api/auth/callback/{provider}` (e.g. `https://myapp.com/api/auth/callback/google`)
3. Set env vars on your ezbase instance:
   ```
   BETTER_AUTH_URL=https://myapp.com          # your public URL (required for OAuth)
   GOOGLE_CLIENT_ID=your-client-id
   GOOGLE_CLIENT_SECRET=your-client-secret
   ```
4. Restart the container

**SDK usage:**

```typescript
// Redirect to OAuth provider (browser-only)
ez.auth.signInWithProvider('google', {
  callbackURL: '/dashboard',           // where to redirect after sign-in
  errorCallbackURL: '/login?error=1',  // optional: where to redirect on error
})
// → browser redirects to Google → user approves → redirects back to callbackURL

// After redirect, restore session on page load
const session = await ez.auth.getSession()
if (session) {
  console.log('Welcome', session.user.email)
  // session.token and session.user are set — SDK auto-attaches token to requests
}

// Check which providers are available
const { providers, emailPassword } = await ez.auth.listProviders()
// → { providers: ['google', 'github'], emailPassword: true }
```

**Account linking:** If a user signs up with email and later signs in with Google using the same email, BetterAuth auto-links the accounts — same user, two auth methods. Google, GitHub, Microsoft, and Apple are trusted providers (they verify emails).

**Supported providers:** `google`, `github`, `microsoft`, `apple`

**Env vars per provider:**

| Provider | Client ID env | Client Secret env |
|----------|--------------|-------------------|
| Google | `GOOGLE_CLIENT_ID` | `GOOGLE_CLIENT_SECRET` |
| GitHub | `GITHUB_CLIENT_ID` | `GITHUB_CLIENT_SECRET` |
| Microsoft | `MICROSOFT_CLIENT_ID` | `MICROSOFT_CLIENT_SECRET` |
| Apple | `APPLE_CLIENT_ID` | `APPLE_CLIENT_SECRET` |

### Custom Claims & Role Management

Users have a `role` (string, default `"user"`) and `claims` (arbitrary JSON metadata). Admin key required for all management methods.

```typescript
const admin = new EzBase({ url: '...', adminKey: '...' })

// Set user roles
await admin.auth.setRole('user-123', 'admin')
await admin.auth.setRole('user-456', 'mover')

// Replace all claims
await admin.auth.setClaims('user-456', { orgId: 'auburn', region: 'southeast' })

// Merge claims (null deletes a key)
await admin.auth.mergeClaims('user-456', { tier: 'pro', region: null })

// List users (paginated)
const users = await admin.auth.listUsers({ limit: 50, offset: 0 })

// Get a single user
const user = await admin.auth.getUser('user-456')

// Delete a user (removes sessions + accounts too)
await admin.auth.deleteUser('user-789')
```

After sign-in, the SDK automatically parses claims:

```typescript
const ez = new EzBase({ url: '...' })
await ez.auth.signIn({ email, password })
console.log(ez.auth.currentUser.role)    // "mover"
console.log(ez.auth.currentUser.claims)  // { orgId: "auburn", tier: "pro" }
```

### TypeScript Generics

```typescript
interface Todo {
  title: string
  done: boolean
  priority?: number
}

const todos = ez.collection<Todo>('todos')
const doc = await todos.add({ title: 'Buy milk', done: false })
// doc.data is typed as Todo
```

### File Storage

Upload, download, list, and delete files. Files are stored on disk; metadata in Postgres. Bucket permissions controlled via `rules.json`.

```typescript
// Upload a file (auto-generated path)
const meta = await ez.storage('avatars').upload(file)
// → { path: 'avatars/m5x8k2j_photo.png', url: '/api/storage/avatars/m5x8k2j_photo.png', size: 48210, ... }

// Upload to specific path
const meta = await ez.storage('avatars').upload('profile.jpg', file)
// → { path: 'avatars/profile.jpg', ... }

// Get URL (no network call)
const url = ez.storage('avatars').file('profile.jpg').url

// Download
const blob = await ez.storage('avatars').file('profile.jpg').download()

// List files in a bucket
const files = await ez.storage('avatars').list()

// Delete
await ez.storage('avatars').file('profile.jpg').delete()
```

`FileMeta` shape returned by upload and list:

```typescript
{
  path: string         // 'avatars/profile.jpg'
  bucket: string       // 'avatars'
  filename: string     // 'profile.jpg'
  size: number         // bytes
  mimeType: string     // 'image/jpeg'
  uploadedBy: string | null  // user ID or null
  created: number      // Unix timestamp (ms)
  updated: number      // Unix timestamp (ms)
  url: string          // '/api/storage/avatars/profile.jpg'
}
```

#### Browser upload (React example)

```typescript
const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
  const file = e.target.files?.[0]
  if (!file) return

  try {
    // Upload with user-specific path — uploadedBy is set automatically from auth
    const meta = await ez.storage('avatars').upload(
      `${ez.auth.currentUser!.id}.jpg`,
      file
    )
    console.log('Uploaded:', meta.url)  // '/api/storage/avatars/user123.jpg'
  } catch (err: any) {
    if (err.message.includes('413')) console.error('File too large (max 100MB)')
    if (err.message.includes('401')) console.error('Not signed in')
    if (err.message.includes('403')) console.error('Permission denied')
  }
}
```

#### Owner buckets — users only see their files

```typescript
// rules.json: { "buckets": { "documents": "owner" } }

// User A uploads
await ez.storage('documents').upload('receipt.pdf', pdfFile)
// → uploadedBy automatically set to User A's ID

// User A lists files — sees only their uploads
const myFiles = await ez.storage('documents').list()

// User B can't access User A's files — gets 403
```

#### Path rules

- Must start with alphanumeric character
- Allowed characters: `a-z A-Z 0-9 _ - . /`
- No `..` (directory traversal blocked)
- No leading or trailing `/`
- Bucket = first path segment (`avatars/photo.jpg` → bucket `avatars`)
- Max file size: 100MB (configurable via `EZBASE_MAX_FILE_SIZE` env var)

#### Error responses

| Status | When |
|--------|------|
| 201 | Upload success |
| 400 | Invalid path (bad characters, `..`, etc.) or no file provided |
| 401 | Anonymous user, bucket requires authentication |
| 403 | User lacks permission (wrong role, not owner) |
| 404 | File not found |
| 413 | File exceeds max size |

#### Bucket permissions in rules.json

```json
{
  "default": "public",
  "collections": { ... },
  "buckets": {
    "avatars": "authenticated",
    "documents": "owner",
    "public_assets": "public"
  }
}
```

- Same access levels as collections: `public`, `authenticated`, `admin`, `owner`, `role:<name>`
- `owner` on a bucket = only the uploader can read/delete their files
- Unlisted buckets fall back to `default`
- No claim-based filters for buckets — strings only

### Exports

```typescript
import { EzBase, DatabaseRef, CollectionRef, DocRef, QueryRef, AuthClient, StorageBucket, FileHandle } from '@ezwrld/ezbase'
import type { Document, WhereOp, OrderDir, EzBaseOptions, AuthUser, FileMeta, RulesFile, CollectionRule, FilterMap, RulesResponse, ReadWriteRule } from '@ezwrld/ezbase'
```

## Rules & Permissions

Permissions are defined in `rules.json` — a single file per ezbase instance. Two ways to manage it:

1. **Console editor** — open the console, click "Rules", edit and save. Rules persist in `/data/rules.json`.
2. **Mounted file** — keep `rules.json` in your repo, mount into the container. Console shows read-only mode.

### rules.json format

```json
{
  "default": "public",
  "collections": {
    "feed": { "read": "public", "write": "authenticated" },
    "profiles": { "read": "public", "write": "owner" },
    "move_orders": {
      "read": { "access": "role:mover", "filter": { "orgId": "claims.orgIds" } },
      "write": "admin"
    },
    "user_notes": "owner",
    "admin_dashboard": "admin"
  }
}
```

- **Read/write split:** `{ "read": "public", "write": "authenticated" }` — separate permissions for reads vs writes. Write covers create, update, and delete.
- **Simple rules:** just a string — `"admin"`, `"public"`, `"authenticated"`, `"owner"`, `"role:mover"` — applies to both read and write.
- **Complex rules:** `read` and `write` each accept a string level or `{ "access": "...", "filter": { ... } }` object.
- **Filter** maps doc fields to auth context: `"auth.id"` = user ID, `"claims.foo"` = user's claim value
- If claim is an array → SQL `ANY()` (IN); if string → `=`
- Multiple filter keys → AND logic
- `"owner"` is sugar for `{ "access": "authenticated", "filter": { "userId": "auth.id" } }`
- `default` is fallback for unlisted collections, also supports `{ "read": "public", "write": "authenticated" }`
- If only `read` or `write` is specified, the other falls back to `default`

### Permission levels

| Level | Anonymous | Authenticated | Matching role | Admin key / admin role |
|-------|-----------|---------------|---------------|----------------------|
| `public` | Full access | Full access | Full access | Full access |
| `authenticated` | 401 | Full access | Full access | Full access |
| `role:<name>` | 401 | 403 | Full access | Full access |
| `owner` | 401 | Own docs only | Own docs only | Full access |
| `admin` | 401 | 403 | 403 | Full access |

### Managing rules via SDK

```typescript
const admin = new EzBase({ url: '...', adminKey: '...' })

// Get current rules
const { rules, readonly } = await admin.getRules()

// Replace entire rules file
await admin.setRules({
  default: 'authenticated',
  collections: {
    move_orders: { access: 'role:mover', filter: { orgId: 'claims.orgIds' } },
    public_feed: 'public',
  },
})

// Simple permission (legacy compat — writes to rules.json)
await admin.setPermission('notes', 'authenticated')

// Permission with filter (new)
await admin.setPermission('orders', { access: 'role:mover', filter: { orgId: 'claims.orgIds' } })

// Get permission level
const perm = await admin.getPermission('todos')
// → { database: 'default', collection: 'todos', level: 'authenticated' }
```

### End-to-end: claims + rules + auto-filtered queries

```typescript
// Admin setup
const admin = new EzBase({ url: '...', adminKey: '...' })
await admin.auth.setRole('user-456', 'mover')
await admin.auth.setClaims('user-456', { orgIds: ['auburn', 'oxford'] })
await admin.setRules({
  default: 'public',
  collections: {
    move_orders: { access: 'role:mover', filter: { orgId: 'claims.orgIds' } },
  },
})

// Client — mover signs in, .get() auto-filters by their orgIds
const ez = new EzBase({ url: '...' })
await ez.auth.signIn({ email, password })
const orders = await ez.collection('move_orders').get()
// → only docs where data.orgId is "auburn" or "oxford"
```

### Mounted (read-only) rules

```yaml
# docker-compose.yml
services:
  ezbase:
    image: ghcr.io/ezwrld/ezbase:latest
    volumes:
      - ./rules.json:/data/rules.json:ro  # read-only mount
```

Console shows rules as read-only. `PUT /api/rules` returns 409.

### Pattern A: "I don't use ezbase auth"

Set collections to `admin`. Your backend talks to ezbase with the admin key. Frontend never touches ezbase directly.

```typescript
// Your backend
const ez = new EzBase({
  url: 'http://ezbase:7003',  // internal Docker network
  adminKey: process.env.EZBASE_ADMIN_KEY,
})

app.get('/api/items', async (req, res) => {
  const userId = req.user.id  // your own auth
  const items = await ez.collection('items')
    .where('userId', '==', userId)
    .get()
  res.json(items)
})
```

### Pattern B: "I use ezbase auth"

Set collections to `authenticated`. SDK handles tokens automatically after sign-in.

```typescript
// Frontend
const ez = new EzBase({ url: 'http://localhost:7003' })
await ez.auth.signIn({ email, password })
// All subsequent calls include the session token
const docs = await ez.collection('notes').get()
```

### Pattern C: "Role-based access with claim filters"

Different users see different collections, and within collections they only see docs matching their claims.

```typescript
// Admin setup — roles + claims + rules
const admin = new EzBase({ url: '...', adminKey: '...' })
await admin.auth.setRole('user-456', 'mover')
await admin.auth.setClaims('user-456', { orgIds: ['auburn', 'oxford'] })
await admin.setRules({
  default: 'public',
  collections: {
    move_orders: { access: 'role:mover', filter: { orgId: 'claims.orgIds' } },
    user_notes: 'owner',  // sugar for { access: 'authenticated', filter: { userId: 'auth.id' } }
  },
})

// Client — mover signs in, queries auto-filter
const ez = new EzBase({ url: '...' })
await ez.auth.signIn({ email, password })
const orders = await ez.collection('move_orders').get()  // only docs where orgId in ['auburn', 'oxford']
const notes = await ez.collection('user_notes').get()     // only user's own docs
```

## REST API

All endpoints under `/api` on port 7003. Auth via `Authorization: Bearer <token>` header (session token or admin key). SSE endpoints use `?token=<token>` query param.

### Documents

| Method | Path | Description |
|--------|------|-------------|
| POST | `/collections/:col` | Create document (201) |
| GET | `/collections/:col` | List / query docs (`?where=...&orderBy=...&order=...&limit=...`) |
| GET | `/collections/:col/:id` | Get doc (404 if missing) |
| PUT | `/collections/:col/:id` | Replace doc (upsert) |
| PATCH | `/collections/:col/:id` | Partial update (merge) |
| DELETE | `/collections/:col/:id` | Delete doc |

### Real-time

| Method | Path | Description |
|--------|------|-------------|
| GET | `/collections/:col/sse` | SSE stream (collection/query) |
| GET | `/collections/:col/:id/sse` | SSE stream (single doc) |

### Auth (BetterAuth)

| Method | Path | Body |
|--------|------|------|
| POST | `/auth/sign-up/email` | `{ email, password, name }` |
| POST | `/auth/sign-in/email` | `{ email, password }` |
| POST | `/auth/sign-out` | — |
| GET | `/auth/me` | — (returns `{ id, email, role, claims }`) |
| GET | `/auth/providers` | — (returns `{ providers, emailPassword }`) |
| POST | `/auth/sign-in/social` | `{ provider, callbackURL }` (OAuth redirect) |
| GET | `/auth/callback/:provider` | OAuth callback (handled by BetterAuth) |

### User Management (admin only)

| Method | Path | Body |
|--------|------|------|
| GET | `/auth/users` | — (`?limit=&offset=`) |
| GET | `/auth/users/:id` | — |
| PUT | `/auth/users/:id/role` | `{ role: "mover" }` |
| PUT | `/auth/users/:id/claims` | `{ orgId: "123" }` (replaces all claims) |
| PATCH | `/auth/users/:id/claims` | `{ tier: "pro" }` (merges, `null` deletes key) |
| DELETE | `/auth/users/:id` | — (deletes user + sessions + accounts) |

### Databases

All document/collection/permission/SSE routes also work under `/api/db/:database/...` for named databases. The legacy `/api/collections/...` routes map to the `default` database.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/databases` | List all database names (public) |
| DELETE | `/db/:database` | Delete a database (admin, cannot delete `default`) |
| POST | `/db/:db/collections/:col` | Create document in named db |
| GET | `/db/:db/collections/:col` | List/query docs in named db |
| GET | `/db/:db/collections/:col/:id` | Get doc in named db |
| PUT | `/db/:db/collections/:col/:id` | Replace doc in named db |
| PATCH | `/db/:db/collections/:col/:id` | Partial update in named db |
| DELETE | `/db/:db/collections/:col/:id` | Delete doc in named db |
| GET | `/db/:db/collections/:col/sse` | SSE stream in named db |
| GET | `/db/:db/collections/:col/:id/sse` | SSE stream (single doc) in named db |
| GET | `/db/:db/collections` | List collections in named db |
| GET | `/db/:db/collections/:col/permissions` | Get permission level in named db (admin) |
| PUT | `/db/:db/collections/:col/permissions` | Set permission level in named db (admin) |

### File Storage

| Method | Path | Description |
|--------|------|-------------|
| GET | `/storage` | List bucket names (admin only) |
| POST | `/storage/:bucket` | Upload file, auto-generated path (multipart/form-data) |
| POST | `/storage/:bucket/*path` | Upload file to specific path |
| GET | `/storage/:bucket` | List files in bucket |
| GET | `/storage/:bucket/*path` | Download file (streams with Content-Type) |
| DELETE | `/storage/:bucket/*path` | Delete file (disk + metadata) |
| HEAD | `/storage/:bucket/*path` | File metadata (Content-Type, Content-Length headers) |

Upload request: `POST` with `multipart/form-data`, field name `file`. Returns `FileMeta` JSON (201).

### Rules (admin only)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/rules` | Get rules.json + readonly flag |
| PUT | `/rules` | Replace entire rules.json (409 if readonly) |
| PUT | `/rules/collections/:col` | Update single collection rule (409 if readonly) |

### Other

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | `{ status: "ok" }` |
| GET | `/collections` | List collection names (default db) |
| GET | `/collections/:col/permissions` | Get permission level (legacy compat, admin) |
| PUT | `/collections/:col/permissions` | Set permission level (legacy compat, admin) |

### Query Parameters (GET `/collections/:col`)

| Param | Example | Description |
|-------|---------|-------------|
| `where` | `[["status","==","active"]]` | JSON array of `[field, op, value]` |
| `orderBy` | `created` | Field to sort by |
| `order` | `desc` | `asc` or `desc` |
| `limit` | `20` | Max docs |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ADMIN_KEY` | No | Admin password. Auto-generated if not set (printed to logs). To rotate: change this and restart. |
| `BETTER_AUTH_URL` | Only for OAuth | Public URL for OAuth callback URLs (e.g. `https://myapp.com`). |
| `DATABASE_URL` | No | Only if using external Postgres. |
| `RULES_PATH` | No | Path to rules.json. Default: `/data/rules.json`. |
| `STORAGE_PATH` | No | File storage directory. Default: `/data/files`. |
| `EZBASE_MAX_FILE_SIZE` | No | Max upload size in bytes. Default: 100MB. |
| `GOOGLE_CLIENT_ID` | No | Google OAuth client ID. Enables "Sign in with Google". |
| `GOOGLE_CLIENT_SECRET` | No | Google OAuth client secret. |
| `GITHUB_CLIENT_ID` | No | GitHub OAuth client ID. Enables "Sign in with GitHub". |
| `GITHUB_CLIENT_SECRET` | No | GitHub OAuth client secret. |
| `MICROSOFT_CLIENT_ID` | No | Microsoft OAuth client ID. Enables "Sign in with Microsoft". |
| `MICROSOFT_CLIENT_SECRET` | No | Microsoft OAuth client secret. |
| `APPLE_CLIENT_ID` | No | Apple OAuth client ID. Enables "Sign in with Apple". |
| `APPLE_CLIENT_SECRET` | No | Apple OAuth client secret. |

## Collection Name Rules

- Must start with a letter
- Only `[a-zA-Z0-9_]`, max 63 characters
- Cannot start with `_ezbase_` (reserved)
- Cannot be `user`, `session`, `account`, `verification` (BetterAuth tables)

## Common Patterns

### User-owned data

```typescript
// Store userId with documents
await ez.collection('notes').add({
  title: 'My note',
  content: '...',
  userId: ez.auth.currentUser!.id,
})

// Query by userId on your backend
const userNotes = await adminEz.collection('notes')
  .where('userId', '==', requestUserId)
  .get()
```

### Config / key-value store

```typescript
// Use known doc IDs for config
await ez.collection('config').doc('site-settings').set({
  siteName: 'My App',
  maintenanceMode: false,
})

const config = await ez.collection('config').doc('site-settings').get()
```

### Real-time dashboard

```typescript
ez.collection('metrics')
  .where('type', '==', 'pageview')
  .orderBy('created', 'desc')
  .limit(100)
  .onSnapshot((docs) => updateChart(docs))
```

### Session persistence (browser)

```typescript
// Save after sign in
const { token, user } = await ez.auth.signIn({ email, password })
localStorage.setItem('ez_token', token)
localStorage.setItem('ez_user', JSON.stringify(user))

// Restore on page load
const savedToken = localStorage.getItem('ez_token')
const savedUser = JSON.parse(localStorage.getItem('ez_user') || 'null')
if (savedToken && savedUser) {
  ez.auth.restoreSession(savedToken, savedUser)
}
```
