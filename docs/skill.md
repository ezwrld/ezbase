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
    environment:
      ADMIN_KEY: "your-secret-admin-key"
      BETTER_AUTH_SECRET: "your-secret-at-least-32-chars-long!!"

volumes:
  ezbase-data:
```

One service, one port (7003), one volume (`/data`). Console UI at `http://localhost:7003/console`.

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

// Current user — { id, email, role } or null
const user = ez.auth.currentUser

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

### Exports

```typescript
import { EzBase, DatabaseRef, CollectionRef, DocRef, QueryRef, AuthClient } from '@ezwrld/ezbase'
import type { Document, WhereOp, OrderDir, EzBaseOptions, AuthUser } from '@ezwrld/ezbase'
```

## Security & Permissions

Every collection has a permission level (default: `public`).

| Level | Anonymous | Authenticated | Admin |
|-------|-----------|---------------|-------|
| `public` | Full access | Full access | Full access |
| `authenticated` | 401 | Full access | Full access |
| `admin` | 401 | 403 | Full access |

Set via REST (admin key required):

```
PUT /api/collections/:name/permissions
Body: { "level": "authenticated" }
Header: Authorization: Bearer <admin-key>
```

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
| GET | `/auth/me` | — |

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

### Other

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | `{ status: "ok" }` |
| GET | `/collections` | List collection names (default db) |
| GET | `/collections/:col/permissions` | Get permission level (admin, default db) |
| PUT | `/collections/:col/permissions` | Set permission level (admin, default db) |

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
| `ADMIN_KEY` | No | Admin key for bypassing permissions. Auto-generated if not set. |
| `BETTER_AUTH_SECRET` | Production | Session signing secret. 32+ characters. |
| `DATABASE_URL` | No | Only if using external Postgres. |

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
