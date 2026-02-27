# ezbase

Self-hosted document database — Firebase-level DX without vendor lock-in.

## Philosophy

ezbase is a **DX wrapper**, not a database engine. The hard problems (storage, indexing, search, auth) are solved by battle-tested tools — Postgres, Meilisearch, BetterAuth. ezbase's job is to glue them together behind a dead-simple SDK and API so you never think about infrastructure. If a good open-source library exists for something, use it. Don't reimplement.

## Docs

Detailed specs and plans live in `docs/`:

| Doc | What's in it |
|-----|-------------|
| `docs/VISION.md` | Full product vision, feature specs, SDK API surface, console pages, security model |
| `docs/STORAGE.md` | File storage plan — filesystem + metadata in Postgres, SDK surface, backup strategy |
| `docs/DISTRIBUTION.md` | Packaging, versioning, GitHub Actions, how to use ezbase in other projects |

## What's built

- **Document CRUD** — create, read, update (full + partial), delete via REST
- **Real-time** — SSE subscriptions at collection, document, and query level
- **Query filtering** — `where`, `orderBy`, `order`, `limit`
- **Auth** — signup/signin, JWT tokens, bcrypt passwords, per-collection permissions (public/authenticated/admin)
- **Console** — React + Vite + Tailwind SPA with live-updating document tables
- **SDK** — zero-dependency TypeScript client, works in Node/Bun/Deno/browsers
- **CLI** — `ez up`, `ez down`, `ez down --nuke`, `ez logs`
- **Distribution setup** — Dockerfile (all-in-one image), GitHub Actions for npm + GHCR publishing

## What's not built yet

File storage, Meilisearch integration, gradual type system, relations, backups, OAuth (plan: BetterAuth).

## Architecture

Monorepo: `server/`, `sdk/`, `console/`. Runs as a Docker Compose stack in development, single all-in-one Docker image for distribution.

| Component | Current | Target |
|-----------|---------|--------|
| **Runtime** | Node.js + Hono | Bun + Hono (native postgres/redis, fewer deps) |
| **Storage** | Single `documents` table | Per-collection tables (`col_*`) |
| **Pub/sub** | Redis pub/sub | Postgres LISTEN/NOTIFY (drop Redis) |
| **Auth** | Custom JWT + bcrypt | BetterAuth (OAuth, 2FA, sessions) |
| **Search** | Not built | Meilisearch |
| **Files** | Not built | Filesystem (Docker volume) + metadata in Postgres |

## Dev workflow

```bash
source setup.sh          # first time — adds `ez` to PATH
ez up                    # start the stack
ez down                  # stop (keep data)
ez down --nuke           # stop + wipe volumes
ez logs [service]        # tail logs
```

Verify: `curl http://localhost:7003/api/health`

## Key files

| File | Purpose |
|------|---------|
| `server/src/index.ts` | Entry point, mounts API at `/api` |
| `server/src/routes.ts` | CRUD, SSE, query building |
| `server/src/auth.ts` | Signup, signin, JWT |
| `server/src/middleware.ts` | Auth extraction, permission checks |
| `server/src/permissions.ts` | Collection permission CRUD |
| `server/src/db.ts` | Postgres pool + schema init |
| `server/src/pubsub.ts` | Redis pub/sub for real-time |
| `sdk/src/index.ts` | Client SDK |
| `console/` | React + Vite admin dashboard |
| `Dockerfile` | All-in-one production image |
| `docker-compose.yml` | Dev stack (postgres, redis, server, console, nginx) |

## API (all under `/api`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/collections` | List collection names |
| POST | `/collections/:col` | Create document |
| GET | `/collections/:col` | List/query documents |
| GET | `/collections/:col/:id` | Get document |
| PUT | `/collections/:col/:id` | Replace document (upsert) |
| PATCH | `/collections/:col/:id` | Partial update |
| DELETE | `/collections/:col/:id` | Delete document |
| GET | `/collections/:col/sse` | SSE (collection/query level) |
| GET | `/collections/:col/:id/sse` | SSE (document level) |
| POST | `/auth/signup` | Register (email + password) |
| POST | `/auth/signin` | Login |
| GET | `/auth/me` | Current user |
| GET | `/collections/:col/permissions` | Get permission level (admin) |
| PUT | `/collections/:col/permissions` | Set permission level (admin) |

## Database

Single table: `documents(collection TEXT, id TEXT, body JSONB, created BIGINT, updated BIGINT)` with composite PK `(collection, id)`. Auth users in `_ezbase_users`. Collection permissions in `_ezbase_config`.

## Releasing

Automatic on merge to main. GitHub Actions detect what changed:
- `sdk/**` changed → bumps SDK patch version, publishes to npm, tags `sdk-vX.X.X`
- `server/**`, `console/**`, `nginx/**`, `docker/**`, `Dockerfile` changed → bumps image patch version, pushes to GHCR, tags `vX.X.X`
