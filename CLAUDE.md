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
| `docs/AUTH.md` | BetterAuth integration details |
| `docs/CI-CD.md` | GitHub Actions workflows (OIDC publishing, Docker builds) |
| `docs/skill.md` | **Canonical SDK & integration reference** — the one file for building with ezbase |
| `docs/ROADMAP.md` | Architecture decisions and roadmap |

## What's built

- **Document CRUD** — create, read, update (full + partial), delete via REST
- **Real-time** — SSE subscriptions at collection, document, and query level
- **Query filtering** — `where`, `orderBy`, `order`, `limit`
- **Multi-database** — multiple isolated databases per instance, each a Postgres schema (`db_*`), auto-created on first write
- **Per-collection tables** — each collection gets its own `col_<name>` Postgres table with GIN indexes
- **Auth** — BetterAuth (email/password, session tokens), per-collection permissions (public/authenticated/admin), shared across databases
- **Console** — React + Vite + Tailwind SPA with database selector and live-updating document tables
- **SDK** — zero-dependency TypeScript client, works in Node/Bun/Deno/browsers
- **CLI** — `ez up`, `ez down`, `ez down --nuke`, `ez logs`
- **Distribution setup** — Dockerfile (all-in-one image), GitHub Actions for npm + GHCR publishing

## What's not built yet

File storage, Meilisearch integration, gradual type system, relations, backups, OAuth providers.

## Architecture

Monorepo: `server/`, `sdk/`, `console/`. Runs as a Docker Compose stack in development, single all-in-one Docker image for distribution.

| Component | Status |
|-----------|--------|
| **Runtime** | Bun + Hono |
| **Storage** | Per-collection tables (`col_*`) in per-database schemas (`db_*`) with JSONB + GIN indexes |
| **Databases** | Multiple databases per instance, each a Postgres schema, auto-created on first write |
| **Pub/sub** | Postgres LISTEN/NOTIFY |
| **Auth** | BetterAuth (sessions, email/password) — shared across databases |
| **Search** | Not built (plan: Meilisearch) |
| **Files** | Not built (plan: filesystem + metadata in Postgres) |

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
| `server/src/auth.ts` | BetterAuth instance + `/me` handler |
| `server/src/middleware.ts` | Auth extraction (BetterAuth sessions), permission checks |
| `server/src/permissions.ts` | Collection permission CRUD |
| `server/src/db.ts` | Postgres connection, `ensureCollection()`, schema init |
| `server/src/pubsub.ts` | Postgres LISTEN/NOTIFY for real-time |
| `sdk/src/index.ts` | Client SDK |
| `console/` | React + Vite admin dashboard |
| `Dockerfile` | All-in-one production image |
| `docker-compose.yml` | Dev stack (postgres, server, console, nginx) |

## API (all under `/api`)

Legacy routes (`/api/collections/...`) target the `default` database. Named database routes use `/api/db/:database/collections/...`.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/databases` | List database names (public) |
| DELETE | `/db/:database` | Delete database (admin, cannot delete `default`) |
| GET | `/collections` | List collection names (default db) |
| POST | `/collections/:col` | Create document (default db) |
| GET | `/collections/:col` | List/query documents (default db) |
| GET | `/collections/:col/:id` | Get document (default db) |
| PUT | `/collections/:col/:id` | Replace document (upsert, default db) |
| PATCH | `/collections/:col/:id` | Partial update (default db) |
| DELETE | `/collections/:col/:id` | Delete document (default db) |
| GET | `/collections/:col/sse` | SSE (collection/query, default db) |
| GET | `/collections/:col/:id/sse` | SSE (document, default db) |
| GET | `/collections/:col/permissions` | Get permission level (admin, default db) |
| PUT | `/collections/:col/permissions` | Set permission level (admin, default db) |
| * | `/db/:database/collections/...` | All collection routes for named database |
| POST | `/auth/sign-up/email` | Register (BetterAuth) |
| POST | `/auth/sign-in/email` | Login (BetterAuth) |
| POST | `/auth/sign-out` | Logout (BetterAuth) |
| GET | `/auth/me` | Current user |

## Database

Each database is a Postgres schema (`db_<name>`). Per-collection tables within each schema: `db_<name>.col_<col>(id TEXT PK, data JSONB, created_at BIGINT, updated_at BIGINT)` with GIN index on `data`. Auth managed by BetterAuth in the `public` schema (`user`, `session`, `account`, `verification` tables), shared across all databases. Collection permissions per database in `db_<name>._ezbase_config`.

## Releasing

Automatic on merge to master. GitHub Actions detect what changed:
- `sdk/**` changed → bumps SDK patch version, publishes to npm as `@ezwrld/ezbase`, tags `sdk-vX.X.X`
- `server/**`, `console/**`, `nginx/**`, `docker/**`, `Dockerfile` changed → bumps image patch version, pushes to GHCR as `ghcr.io/ezwrld/ezbase`, tags `vX.X.X`
