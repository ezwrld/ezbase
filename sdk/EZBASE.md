# ezbase SDK — v0.1.0

> **Full reference:** See [`docs/skill.md`](../docs/skill.md) for the complete SDK & integration guide (setup, auth patterns, permissions, REST API, common patterns).

ezbase is a self-hosted document database with real-time subscriptions. This is the TypeScript client SDK. Zero dependencies, works in Node 18+, Bun, Deno, and browsers.

## Setup

```bash
npm install @ezwrld/ezbase
```

## Connect

```ts
import { EzBase } from '@ezwrld/ezbase'

// Basic — all collections default to public access
const ez = new EzBase({ url: 'http://localhost:7003' })

// With admin key — full access to all collections + management APIs
const ez = new EzBase({ url: 'http://localhost:7003', adminKey: 'your-admin-key' })

// Optional name — shows in error messages for multi-environment setups
const ez = new EzBase({ url: 'http://localhost:7003', name: 'production' })
```

## Documents

Every document has this shape:

```ts
{
  id: string       // auto-generated sortable ID
  data: T          // your JSON data
  created: number  // unix timestamp (ms)
  updated: number  // unix timestamp (ms)
}
```

Collections are created implicitly on first write. No schema setup needed.

## CRUD

### Create a document

```ts
const doc = await ez.collection('todos').add({ title: 'Buy milk', done: false })
// doc.id    → "m5x8k2j..."
// doc.data  → { title: 'Buy milk', done: false }
```

### Get a document by ID

```ts
const doc = await ez.collection('todos').doc('m5x8k2j...').get()
// Returns Document or null if not found
```

### List all documents in a collection

```ts
const todos = await ez.collection('todos').get()
// Returns Document[]
```

### Replace a document (PUT)

Overwrites the entire document body. Creates the document if it doesn't exist (upsert).

```ts
const doc = await ez.collection('todos').doc('m5x8k2j...').set({
  title: 'Buy oat milk',
  done: false,
  priority: 'high',
})
```

### Partial update (PATCH)

Merges fields into the existing document. Returns 404 if the document doesn't exist.

```ts
const doc = await ez.collection('todos').doc('m5x8k2j...').update({ done: true })
```

### Delete a document

```ts
await ez.collection('todos').doc('m5x8k2j...').delete()
```

## Queries

Chainable filters on a collection. All queries return `Document[]`.

```ts
// Single filter
const active = await ez.collection('todos')
  .where('done', '==', false)
  .get()

// Multiple filters (AND)
const urgent = await ez.collection('todos')
  .where('done', '==', false)
  .where('priority', '==', 'high')
  .get()

// Ordering
const newest = await ez.collection('todos')
  .orderBy('created', 'desc')
  .get()

// Limit
const top5 = await ez.collection('todos')
  .orderBy('created', 'desc')
  .limit(5)
  .get()

// Combined
const results = await ez.collection('todos')
  .where('done', '==', false)
  .orderBy('created', 'desc')
  .limit(10)
  .get()
```

Supported operators: `==`, `!=`, `<`, `>`, `<=`, `>=`

You can filter on `created` and `updated` timestamps directly:

```ts
const recent = await ez.collection('todos')
  .where('created', '>', Date.now() - 86400000)
  .get()
```

## Real-time Subscriptions (SSE)

Subscribe to live updates. The callback fires immediately with the current state, then again whenever data changes.

### Subscribe to a collection

```ts
const unsub = ez.collection('todos').onSnapshot((docs) => {
  console.log('all todos:', docs)
})

// Stop listening
unsub()
```

### Subscribe to a single document

```ts
const unsub = ez.collection('todos').doc('m5x8k2j...').onSnapshot((doc) => {
  // doc is Document | null (null if deleted)
  console.log('todo changed:', doc)
})
```

### Subscribe to a query

```ts
const unsub = ez.collection('todos')
  .where('done', '==', false)
  .orderBy('created', 'desc')
  .onSnapshot((docs) => {
    console.log('active todos:', docs)
  })
```

All `onSnapshot` methods accept an optional error handler:

```ts
const unsub = ez.collection('todos').onSnapshot(
  (docs) => { /* handle data */ },
  (err) => { console.error('SSE error:', err) }
)
```

Realtime subscriptions use the same bearer authorization header as ordinary SDK reads. Credentials are never added to the subscription URL.
If the server closes a subscription, the error handler receives `SSE connection closed`; applications can reconnect on their own schedule.

## Auth

### Email/password sign in

```ts
// Create an account
const { token, user } = await ez.auth.signUp({
  email: 'alice@example.com',
  password: 'min8chars',
})

// Sign in to existing account
const { token, user } = await ez.auth.signIn({
  email: 'alice@example.com',
  password: 'min8chars',
})

// Sign out (clears token)
ez.auth.signOut()
```

After sign-in, the token is automatically attached to all subsequent requests. No manual header management needed.

### OAuth sign in

Requires provider env vars set on the server (e.g. `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `EZBASE_URL`).

```ts
// Redirect to OAuth provider (browser-only)
ez.auth.signInWithProvider('google', {
  callbackURL: '/dashboard',
  errorCallbackURL: '/login?error=1',  // optional
})

// After redirect, restore session on page load
const session = await ez.auth.getSession()
if (session) {
  console.log('Welcome', session.user.email)
}

// Check which providers the server supports
const { providers, emailPassword } = await ez.auth.listProviders()
// → { providers: ['google', 'github'], emailPassword: true }
```

Supported providers: `google`, `github`, `microsoft`, `apple`.

Account linking is automatic — same email across providers = same user.

### Current user

```ts
const user = ez.auth.currentUser
// { id, email, role, claims, name?, image?, created, updated } or null
// user.role    → "user" (default), "admin", "mover", etc.
// user.claims  → { orgId: "auburn", tier: "pro" }
```

### Listen to auth state changes

```ts
const unsub = ez.auth.onAuthStateChanged((user) => {
  if (user) {
    console.log('signed in as', user.email)
  } else {
    console.log('signed out')
  }
})
```

### Admin: User Management

Requires admin key.

```ts
const admin = new EzBase({ url: '...', adminKey: '...' })

await admin.auth.listUsers({ limit: 50, offset: 0 })     // paginated user list
await admin.auth.getUser('user-123')                       // single user
await admin.auth.setRole('user-123', 'mover')              // set role
await admin.auth.setClaims('user-123', { orgId: 'auburn' }) // replace claims
await admin.auth.mergeClaims('user-123', { tier: 'pro' })  // merge (null deletes key)
await admin.auth.deleteUser('user-789')                     // delete user + sessions
```

## Rules & Permissions

Permissions are defined in `rules.json`. Managed via console editor, mounted file, or SDK.

### rules.json format

```json
{
  "default": "public",
  "collections": {
    "feed": { "read": "public", "write": "authenticated" },
    "orders": {
      "read": { "access": "role:mover", "filter": { "orgId": "claims.orgIds" } },
      "write": "admin"
    },
    "user_notes": "owner",
    "admin_dashboard": "admin"
  }
}
```

| Level | Anonymous | Authenticated user | Matching role | Admin |
|-------|-----------|-------------------|---------------|-------|
| `public` (default) | Full access | Full access | Full access | Full access |
| `authenticated` | Blocked (401) | Full access | Full access | Full access |
| `role:<name>` | Blocked (401) | Blocked (403) | Full access | Full access |
| `owner` | Blocked (401) | Own docs only | Own docs only | Full access |
| `admin` | Blocked (401) | Blocked (403) | Blocked (403) | Full access |

- **Read/write split**: `{ "read": "public", "write": "authenticated" }` — separate permissions for reads vs writes. Write = create, update, delete.
- **`owner`**: Sugar for `{ access: "authenticated", filter: { userId: "auth.id" } }`
- **`role:<name>`**: Only users with matching role can access
- **Filters**: Map doc fields to `auth.id` or `claims.*`. Array claims use SQL `ANY()`, multiple filters AND'd.

### Rules SDK methods

```ts
const admin = new EzBase({ url: '...', adminKey: '...' })

// Get rules
const { rules, readonly } = await admin.getRules()

// Replace rules (supports read/write split)
await admin.setRules({
  default: { read: 'public', write: 'authenticated' },
  collections: { feed: 'public', orders: { read: 'authenticated', write: 'admin' } },
})

// Set permission (string or object with filter)
await admin.setPermission('orders', { access: 'role:mover', filter: { orgId: 'claims.orgIds' } })
await admin.setPermission('notes', 'authenticated')
```

## TypeScript Generics

Type your collections for full IntelliSense:

```ts
interface Todo {
  title: string
  done: boolean
  priority?: 'low' | 'medium' | 'high'
}

const todos = ez.collection<Todo>('todos')
const doc = await todos.add({ title: 'Buy milk', done: false })
// doc.data is typed as Todo
```

## Multiple Databases

One ezbase instance can have multiple databases. Each database is an isolated set of collections with shared auth.

```ts
// Default database (shorthand)
await ez.collection('todos').add({ title: 'Ship it' })

// Named databases
const auburn = ez.database('auburn')
await auburn.collection('orders').add({ customer: 'Alice', total: 250 })

// Databases auto-create on first write, just like collections
```

### Admin Methods

```ts
const ez = new EzBase({ url: '...', adminKey: '...' })

await ez.listDatabases()                                   // ['default', 'auburn']
await ez.listCollections()                                 // default db collections
await ez.database('auburn').listCollections()               // auburn's collections

await ez.setPermission('todos', 'authenticated')                                      // simple
await ez.setPermission('orders', { access: 'role:mover', filter: { orgId: 'claims.orgIds' } })  // with filter
await ez.database('auburn').setPermission('orders', 'admin')                            // named db
await ez.getPermission('todos')
// → { database: 'default', collection: 'todos', level: 'authenticated' }

// Rules management
await ez.getRules()       // → { rules: {...}, readonly: false }
await ez.setRules({ default: 'authenticated', collections: { feed: 'public' } })
```

## File Storage

Upload, download, list, and delete files. Bucket permissions controlled via `rules.json`.

```ts
// Upload (auto-generated path)
const meta = await ez.storage('avatars').upload(file)
// → { path: 'avatars/m5x8k2j_photo.png', url: '/api/storage/...', size, mimeType, ... }

// Upload to specific path
const meta = await ez.storage('avatars').upload('profile.jpg', file)

// Get URL (no network call — computed from base URL)
const url = ez.storage('avatars').file('profile.jpg').url

// Download as blob
const blob = await ez.storage('avatars').file('profile.jpg').download()

// List all files in a bucket
const files = await ez.storage('avatars').list()

// Delete file (disk + metadata)
await ez.storage('avatars').file('profile.jpg').delete()
```

`FileMeta` shape:

```ts
{
  path: string, bucket: string, filename: string,
  size: number, mimeType: string, uploadedBy: string | null,
  created: number, updated: number, url: string
}
```

## Exports

```ts
import { EzBase } from '@ezwrld/ezbase'
// or
import { EzBase, DatabaseRef, CollectionRef, DocRef, QueryRef, AuthClient, StorageBucket, FileHandle } from '@ezwrld/ezbase'
// types
import type { Document, WhereOp, OrderDir, EzBaseOptions, AuthUser, FileMeta, RulesFile, CollectionRule, FilterMap, RulesResponse, ReadWriteRule } from '@ezwrld/ezbase'
```
