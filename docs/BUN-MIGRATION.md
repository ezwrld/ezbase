# Bun Migration Plan

**Status:** Not yet built. Migrates server runtime from Node.js to Bun.

## Why Bun

- **Native postgres** (`Bun.sql`) — zero-dependency, ~50% faster row reads than `pg`
- **Native redis** (`Bun.RedisClient`) — if we keep Redis temporarily
- **Hono needs no adapter** — just `export default app`, no `@hono/node-server`
- **Fewer dependencies** — drop `pg`, `@types/pg`, `redis`, `@hono/node-server`, `tsx`
- **Faster startup** — Bun runs TypeScript directly, no transpilation step
- **Simpler Docker image** — Bun's base image is smaller than Node's

## What changes

### 1. Server entry point (`server/src/index.ts`)

Before (Node):
```typescript
import { serve } from '@hono/node-server'
import { app } from './app.js'
serve({ fetch: app.fetch, port: Number(process.env.PORT) || 8080 })
```

After (Bun):
```typescript
import { app } from './app.js'
export default {
  port: Number(process.env.PORT) || 8080,
  fetch: app.fetch,
}
```

### 2. Database (`server/src/db.ts`)

Before (Node + pg):
```typescript
import { Pool } from 'pg'
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const result = await pool.query('SELECT * FROM documents WHERE id = $1', [id])
```

After (Bun.sql):
```typescript
import { sql } from 'bun'
// Connection configured via DATABASE_URL env var automatically
const result = await sql`SELECT * FROM documents WHERE id = ${id}`
```

Key differences:
- Tagged template literals instead of parameterized query strings
- Bun.sql auto-reads `DATABASE_URL` from env
- Automatic prepared statements and connection pooling
- Returns arrays directly, not `{ rows: [...] }` wrapper

### 3. Pub/sub — Replace Redis with Postgres LISTEN/NOTIFY

This is the big win. Drop Redis entirely.

Before (Redis):
```typescript
import { createClient } from 'redis'
await pub.publish(`ezbase:${collection}`, JSON.stringify(event))
await sub.subscribe(`ezbase:${collection}`, callback)
```

After (Postgres LISTEN/NOTIFY):
```typescript
import { sql } from 'bun'

// Publish
await sql`SELECT pg_notify(${channel}, ${JSON.stringify(event)})`

// Subscribe
await sql.subscribe(channel, (payload) => {
  const event = JSON.parse(payload)
  callback(event)
})
```

Or with raw LISTEN/NOTIFY if Bun.sql doesn't support `.subscribe()`:
```typescript
// Dedicated connection for listening
const listener = await sql.reserve()
await listener.unsafe(`LISTEN "ezbase:${collection}"`)
// Handle notifications via the connection's notification event
```

**Note:** Postgres NOTIFY has an 8KB payload limit. For documents larger than that, publish just the change metadata (type, id, collection) and let SSE handlers re-query for the full document. This is actually better anyway — the SSE handler already re-queries on every change.

### 4. Server Dockerfile

Before:
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
CMD ["npx", "tsx", "src/index.ts"]
```

After:
```dockerfile
FROM oven/bun:1-alpine
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install
COPY . .
CMD ["bun", "run", "src/index.ts"]
```

### 5. Root Dockerfile (all-in-one image)

- Base image: still needs Debian for postgres/nginx, but install Bun instead of Node
- Remove Redis installation (not needed anymore)
- Remove Redis from supervisord.conf
- Simpler — 3 processes instead of 4 (postgres, server, nginx)

### 6. docker-compose.yml

Remove the redis service entirely:
```yaml
services:
  postgres:
    image: postgres:16-alpine
    # ...

  server:
    build: ./server
    environment:
      DATABASE_URL: postgresql://ezbase:ezbase@postgres:5432/ezbase
      PORT: "8080"
    depends_on:
      postgres:
        condition: service_healthy

  # redis: REMOVED

  console:
    build: ./console
    # ...

  nginx:
    # ...
```

### 7. Dependencies to remove
- `pg` and `@types/pg`
- `redis`
- `@hono/node-server`
- `tsx` (Bun runs TypeScript natively)

### 8. Dependencies to keep
- `hono` (runtime-agnostic)
- `bcryptjs` and `@types/bcryptjs` (until BetterAuth replaces auth)

### 9. Dependencies to maybe add
- `postgres` (porsager) — fallback if `Bun.sql` has edge cases. Battle-tested, works on Bun natively. Same tagged template API.

## Migration order

1. **Switch server Dockerfile to Bun** — `oven/bun:1-alpine`, `bun run src/index.ts`
2. **Replace entry point** — remove `@hono/node-server`, use `export default`
3. **Replace `pg` with `Bun.sql`** — rewrite `db.ts` with tagged templates
4. **Replace Redis with LISTEN/NOTIFY** — rewrite `pubsub.ts`, remove redis service from compose
5. **Test everything** — CRUD, SSE, auth, query filtering
6. **Update root Dockerfile** — remove Redis from all-in-one image
7. **Clean up** — remove unused deps from package.json

## Risks and fallbacks

| Risk | Mitigation |
|------|-----------|
| `Bun.sql` edge cases (it's newer) | Fall back to `postgres` by porsager — same API, battle-tested |
| LISTEN/NOTIFY 8KB payload limit | Only publish metadata in notifications, re-query for full docs (already the pattern for SSE) |
| Bun compatibility with some npm package | Check bcryptjs, hono — both known to work on Bun |
| Console build (Vite) | Vite works on Bun, but can also just use Node for the build stage |

## What this enables

- **3 processes instead of 4** in the all-in-one image (no Redis)
- **Fewer npm dependencies** — native SQL and built-in TypeScript
- **Simpler architecture** — Postgres is the single source of truth for everything (data, pub/sub, auth)
- **Performance** — native Zig-based postgres driver, faster startup, lower memory
