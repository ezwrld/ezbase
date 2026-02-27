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

## Auth

### Sign up and sign in

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

### Current user

```ts
const user = ez.auth.currentUser
// { id, email, role, created, updated } or null
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

## Permission Levels

Collections have three permission levels, set via the admin console or API:

| Level | Anonymous | Authenticated user | Admin |
|-------|-----------|-------------------|-------|
| `public` (default) | Full access | Full access | Full access |
| `authenticated` | Blocked (401) | Full access | Full access |
| `admin` | Blocked (401) | Blocked (403) | Full access |

New collections default to `public`. Existing data and behavior is unchanged until you set a stricter level.

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

await ez.setPermission('todos', 'authenticated')            // default db
await ez.database('auburn').setPermission('orders', 'admin')
await ez.getPermission('todos')
// → { database: 'default', collection: 'todos', level: 'authenticated' }
```

## Exports

```ts
import { EzBase } from '@ezwrld/ezbase'
// or
import { EzBase, DatabaseRef, CollectionRef, DocRef, QueryRef, AuthClient } from '@ezwrld/ezbase'
// types
import type { Document, WhereOp, OrderDir, EzBaseOptions, AuthUser } from '@ezwrld/ezbase'
```
