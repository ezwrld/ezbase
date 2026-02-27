# ezbase Implementation Guide

This is the reference doc for setting up and using ezbase in a project. If you're an AI agent or developer working on a project that uses ezbase, start here.

---

## What is ezbase?

A self-hosted document database. One Docker image gives you:
- Document store (Postgres JSONB)
- Real-time subscriptions (SSE via Postgres LISTEN/NOTIFY)
- Auth (email/password via BetterAuth, session tokens, per-collection permissions)
- Admin console (React web UI)

Think Firebase but self-hosted, zero config, runs anywhere Docker runs.

---

## Adding ezbase to a project

### 1. Docker Compose

Add ezbase as a service in your `docker-compose.yml`:

```yaml
services:
  # your app
  app:
    build: .
    ports:
      - "3000:3000"

  # ezbase
  ezbase:
    image: ghcr.io/ezwrld/ezbase:latest
    ports:
      - "7003:7003"
    volumes:
      - ezbase-data:/data

volumes:
  ezbase-data:
```

One service, one port (7003), one volume (`/data`). Start with `docker compose up`.

### 2. Install the SDK

```bash
npm install @ezwrld/ezbase
```

### 3. Initialize

```typescript
import { EzBase } from '@ezwrld/ezbase'

// Client mode — respects collection permissions
const ez = new EzBase({ url: 'http://localhost:7003' })

// Admin mode — bypasses all permissions
const ez = new EzBase({
  url: 'http://localhost:7003',
  adminKey: 'your-admin-key',  // printed to server logs on first start
})
```

The admin key is auto-generated on first boot and printed to the server logs. Set the `ADMIN_KEY` env var to use a fixed key.

---

## SDK API

### Documents

```typescript
// Create (auto-generated ID)
const doc = await ez.collection('todos').add({ title: 'Ship it', done: false })
// → { id: 'mm43zet25...', data: { title: 'Ship it', done: false }, created: 1234, updated: 1234 }

// Get one
const todo = await ez.collection('todos').doc('abc123').get()
// → { id: 'abc123', data: {...}, created: 1234, updated: 1234 } or null

// List all
const todos = await ez.collection('todos').get()
// → [{ id, data, created, updated }, ...]

// Replace (upsert)
await ez.collection('todos').doc('abc123').set({ title: 'Done', done: true })

// Partial update (merge)
await ez.collection('todos').doc('abc123').update({ done: true })

// Delete
await ez.collection('todos').doc('abc123').delete()
```

### Queries

```typescript
const results = await ez.collection('todos')
  .where('done', '==', false)
  .where('priority', '>', 5)
  .orderBy('created', 'desc')
  .limit(20)
  .get()
```

Supported operators: `==`, `!=`, `<`, `>`, `<=`, `>=`

### Real-time subscriptions

```typescript
// Subscribe to a collection
const unsub = ez.collection('todos').onSnapshot((docs) => {
  console.log('All todos:', docs)
})

// Subscribe to a query
const unsub = ez.collection('todos')
  .where('done', '==', false)
  .onSnapshot((docs) => {
    console.log('Active todos:', docs)
  })

// Subscribe to a single document
const unsub = ez.collection('todos').doc('abc123').onSnapshot((doc) => {
  console.log('Todo changed:', doc)
})

// Stop listening
unsub()
```

Subscriptions use SSE. On any change (create, update, delete), the server pushes a fresh snapshot of the data.

### Auth

```typescript
// Sign up
const { token, user } = await ez.auth.signUp({
  email: 'user@example.com',
  password: 'password123',
})

// Sign in
const { token, user } = await ez.auth.signIn({
  email: 'user@example.com',
  password: 'password123',
})

// Current user (null if not signed in)
const user = ez.auth.currentUser

// Watch auth state
ez.auth.onAuthStateChanged((user) => {
  if (user) console.log('Signed in:', user.email)
  else console.log('Signed out')
})

// Sign out
await ez.auth.signOut()

// Restore session (e.g. from localStorage)
ez.auth.restoreSession(savedToken, savedUser)
```

### Collection permissions

Set via the API with admin key:

```typescript
// Make a collection require authentication
await fetch('http://localhost:7003/api/collections/private-stuff/permissions', {
  method: 'PUT',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer YOUR_ADMIN_KEY',
  },
  body: JSON.stringify({ level: 'authenticated' }),
})
```

Levels:
- `public` (default) — anyone can read/write
- `authenticated` — requires a valid session token
- `admin` — requires admin key

---

## REST API

All endpoints under `/api` on port 7003.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/collections` | List all collection names |
| POST | `/collections/:col` | Create document |
| GET | `/collections/:col` | List / query documents |
| GET | `/collections/:col/:id` | Get document |
| PUT | `/collections/:col/:id` | Replace document (upsert) |
| PATCH | `/collections/:col/:id` | Partial update |
| DELETE | `/collections/:col/:id` | Delete document |
| GET | `/collections/:col/sse` | Subscribe to collection (SSE) |
| GET | `/collections/:col/:id/sse` | Subscribe to document (SSE) |
| POST | `/auth/sign-up/email` | Create account (BetterAuth) |
| POST | `/auth/sign-in/email` | Sign in (BetterAuth) |
| POST | `/auth/sign-out` | Sign out (BetterAuth) |
| GET | `/auth/me` | Current user |
| GET | `/collections/:col/permissions` | Get permission level (admin) |
| PUT | `/collections/:col/permissions` | Set permission level (admin) |

### Query parameters (on GET `/collections/:col`)

| Param | Example | Description |
|-------|---------|-------------|
| `where` | `[["status","==","active"]]` | JSON array of `[field, op, value]` clauses |
| `orderBy` | `created` | Field to sort by |
| `order` | `desc` | Sort direction (`asc` or `desc`) |
| `limit` | `20` | Max documents to return |

### Auth headers

```
Authorization: Bearer <session-token>     # for authenticated users
Authorization: Bearer <admin-key>         # for admin access
```

For SSE endpoints, pass token as query param since EventSource can't set headers:
```
/api/collections/todos/sse?token=<session-token>
```

---

## Environment variables

Pass these to the ezbase container:

| Variable | Default | Description |
|----------|---------|-------------|
| `ADMIN_KEY` | auto-generated | Admin key for bypassing permissions |
| `BETTER_AUTH_SECRET` | auto-generated | Secret for BetterAuth session signing |
| `DATABASE_URL` | internal | Postgres connection string (only override if using external Postgres) |

For production, set `ADMIN_KEY` and `BETTER_AUTH_SECRET` explicitly so they persist across container restarts:

```yaml
ezbase:
  image: ghcr.io/ezwrld/ezbase:latest
  ports:
    - "7003:7003"
  volumes:
    - ezbase-data:/data
  environment:
    ADMIN_KEY: "your-secret-admin-key"
    BETTER_AUTH_SECRET: "your-secret-auth-secret"
```

---

## Admin console

Available at `http://localhost:7003/console/`. Shows:
- All collections with document counts
- Live-updating document tables
- Collection statistics

---

## Architecture

Everything runs inside one container:

```
ezbase container (port 7003)
├── nginx          → reverse proxy, serves console
├── bun server     → Hono REST API + SSE
├── postgres       → document storage, LISTEN/NOTIFY pub/sub, auth
└── /data volume   → postgres data, file storage (future)
```

The SDK talks to the API through nginx. Collections are implicit — created on first write. No migrations, no schema, no setup.

---

## Developing ezbase itself

Clone the repo and use the dev stack:

```bash
git clone https://github.com/ezwrld/ezbase.git
cd ezbase
source setup.sh    # adds `ez` to PATH
ez up              # starts dev stack (separate containers, hot reload)
ez logs            # tail logs
ez down            # stop
ez down --nuke     # stop + wipe data
```

The dev stack uses `docker-compose.yml` with separate containers for each service. The production all-in-one image uses a different `Dockerfile` at the root.

---

## Roadmap

See `docs/` in the repo for detailed plans:
- `docs/STORAGE.md` — file storage (filesystem + metadata in Postgres)
- `docs/AUTH.md` — BetterAuth integration details
- `docs/DISTRIBUTION.md` — packaging and versioning
- `docs/CI-CD.md` — GitHub Actions workflows
- `docs/VISION.md` — full product vision
