# ezbase

Self-hosted document database with Firebase-level DX. One Docker image, one port, zero config.

ezbase wraps Postgres (JSONB), Meilisearch, and other battle-tested tools behind a simple REST API and TypeScript SDK. You get real-time subscriptions, auth, full-text search, and file storage — all self-hosted, all on a single $10/mo VPS.

## Quick start

### Option 1: Add to your Docker Compose stack

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

```bash
npm install ezbase
```

```typescript
import { EzBase } from 'ezbase'

const ez = new EzBase({ url: 'http://localhost:7003' })

// Write
await ez.collection('todos').add({ title: 'Ship it', done: false })

// Read
const todos = await ez.collection('todos').get()

// Query
const active = await ez.collection('todos')
  .where('done', '==', false)
  .orderBy('created', 'desc')
  .limit(10)
  .get()

// Real-time
ez.collection('todos').onSnapshot((docs) => {
  console.log('Todos changed:', docs)
})
```

### Option 2: Clone and run locally

```bash
git clone https://github.com/ezwrld/ezbase.git
cd ezbase
source setup.sh
ez up
```

Open `http://localhost:7003/console` for the admin dashboard.

## Features

**Document store** — schemaless JSONB documents. Collections are created implicitly on first write. No migrations, no setup.

**Real-time** — subscribe to collections, queries, or individual documents via SSE. Changes push instantly.

**Auth** — email/password signup/signin with JWT tokens. Per-collection permissions: `public`, `authenticated`, or `admin`.

**Querying** — filter with `where`, sort with `orderBy`, paginate with `limit`. Operators: `==`, `!=`, `<`, `>`, `<=`, `>=`.

**Admin console** — React web UI for browsing collections, viewing documents, and managing your instance.

## SDK

```typescript
const ez = new EzBase({ url: 'http://localhost:7003' })

// CRUD
await ez.collection('users').add({ name: 'Reid', role: 'admin' })
const user = await ez.collection('users').doc('abc123').get()
await ez.collection('users').doc('abc123').update({ role: 'superadmin' })
await ez.collection('users').doc('abc123').delete()

// Upsert
await ez.collection('users').doc('abc123').set({ name: 'Reid', role: 'admin' })

// Queries
const admins = await ez.collection('users')
  .where('role', '==', 'admin')
  .orderBy('name')
  .get()

// Real-time subscriptions
const unsubscribe = ez.collection('messages')
  .where('room', '==', 'general')
  .onSnapshot((messages) => {
    renderMessages(messages)
  })

// Auth
await ez.auth.signUp({ email: 'reid@example.com', password: 'password123' })
await ez.auth.signIn({ email: 'reid@example.com', password: 'password123' })
const user = ez.auth.currentUser
ez.auth.onAuthStateChanged((user) => { /* ... */ })

// Admin mode (bypasses all permission rules)
const admin = new EzBase({
  url: 'http://localhost:7003',
  adminKey: 'your-admin-key',
})
```

The SDK is zero-dependency and works in Node, Bun, Deno, and browsers.

## API

All endpoints are under `/api`.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/collections` | List all collections |
| POST | `/collections/:col` | Create document |
| GET | `/collections/:col` | List / query documents |
| GET | `/collections/:col/:id` | Get document |
| PUT | `/collections/:col/:id` | Replace document (upsert) |
| PATCH | `/collections/:col/:id` | Partial update |
| DELETE | `/collections/:col/:id` | Delete document |
| GET | `/collections/:col/sse` | Subscribe to collection (SSE) |
| GET | `/collections/:col/:id/sse` | Subscribe to document (SSE) |
| POST | `/auth/signup` | Create account |
| POST | `/auth/signin` | Sign in |
| GET | `/auth/me` | Current user |

## Architecture

ezbase is a thin DX wrapper around proven infrastructure — not a database engine. Under the hood:

- **Postgres** — document storage (JSONB), pub/sub (LISTEN/NOTIFY), auth
- **Hono** — REST API framework (runs on Bun)
- **Nginx** — reverse proxy, single port exposure

One Docker image bundles everything. One volume holds all data. One port serves the API and console.

## Development

```bash
source setup.sh    # adds `ez` to PATH (one-time)
ez up              # start the dev stack
ez logs            # tail logs (pass service name to filter)
ez down            # stop (keep data)
ez down --nuke     # stop and wipe all data
```

The dev stack runs each service as a separate container (Postgres, Bun server, Vite console, Nginx) with hot reloading.

## Roadmap

- [x] Document CRUD + queries
- [x] Real-time subscriptions (SSE)
- [x] Auth (email/password, JWT, permissions)
- [x] Admin console (React)
- [ ] File storage
- [ ] Full-text search (Meilisearch)
- [ ] OAuth providers
- [ ] Gradual type system
- [ ] Backups

## License

MIT
