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
| `docs/RULES.md` | **Rules & security** — permission levels, filters, Firebase translations, multi-tenancy, write enforcement |
| `docs/AUTH.md` | BetterAuth integration details |
| `docs/OAUTH-PROVIDERS.md` | Acquiring OAuth credentials per provider (Google, GitHub, Microsoft, Apple) |
| `docs/CI-CD.md` | GitHub Actions workflows (OIDC publishing, Docker builds) |
| `docs/skill.md` | **Canonical SDK & integration reference** — the one file for building with ezbase |
| `docs/ROADMAP.md` | Architecture decisions and roadmap |

## What's built

- **Document CRUD** — create, read, update (full + partial), delete via REST
- **Real-time** — SSE subscriptions at collection, document, and query level
- **Query filtering** — `where`, `orderBy`, `order`, `limit`
- **Multi-database** — multiple isolated databases per instance, each a Postgres schema (`db_*`), auto-created on first write
- **Per-collection tables** — each collection gets its own `col_<name>` Postgres table with GIN indexes
- **Auth** — BetterAuth (email/password, OAuth providers, session tokens), per-collection permissions (public/authenticated/admin/owner/role:*), custom claims, user management endpoints, shared across databases. Password reset/change (SMTP via `SMTP_*` env, or links logged without it), admin set-password, optional email verification, brute-force rate limiting always on (`EZBASE_RATE_LIMIT=false` for test stacks only), `EZBASE_TRUSTED_ORIGINS` for cross-domain frontends
- **Rules** — Declarative `rules.json` for per-collection access control + claim-based document filters (replaces `_ezbase_config` Postgres table)
- **File Storage** — upload/download/delete files via REST, stored on disk (Docker volume), metadata in Postgres (`_ezbase_files`), bucket permissions via `rules.json`
- **Backups** — streaming tar.gz backups (JSONL per collection + manifest + auth + storage + rules), granular restore (per database/collection/part), query-filtered restore (`where` + time bounds), conflict modes (replace/skip/error), `ez backup --stdout` piping for off-site — see `docs/BACKUPS.md`
- **Analytics** — built-in request analytics: every API call classified + aggregated into per-minute buckets (internal `_ezbase_metrics` table, 14-day retention), admin endpoints for summary/timeseries/live SSE feed, Activity page in console
- **Console** — React + Vite + Tailwind SPA with database selector, live-updating document tables, Activity dashboard (stat tiles, requests/min chart, top collections, live request feed), rules editor, and storage browser
- **SDK** — zero-dependency TypeScript client, works in Node/Bun/Deno/browsers
- **CLI** — `ez up`, `ez down`, `ez down --nuke`, `ez logs`, `ez backup`, `ez restore`
- **Distribution setup** — Dockerfile (all-in-one image), GitHub Actions for npm + GHCR publishing

## What's not built yet

Meilisearch integration, gradual type system, relations, backup scheduling/console UI/S3 push (see `docs/BACKUPS.md` future phases), declarative rules (ezbase.json).

## Architecture

Monorepo: `server/`, `sdk/`, `console/`. Runs as a Docker Compose stack in development, single all-in-one Docker image for distribution.

| Component | Status |
|-----------|--------|
| **Runtime** | Bun + Hono |
| **Storage** | Per-collection tables (`col_*`) in per-database schemas (`db_*`) with JSONB + GIN indexes |
| **Databases** | Multiple databases per instance, each a Postgres schema, auto-created on first write |
| **Pub/sub** | Postgres LISTEN/NOTIFY |
| **Auth** | BetterAuth (sessions, email/password, OAuth providers) — shared across databases |
| **Files** | On-disk storage (Docker volume) + metadata in Postgres (`_ezbase_files`), bucket permissions via `rules.json` |
| **Search** | Not built (plan: Meilisearch) |

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
| `server/src/storage.ts` | File storage routes: upload, download, list, delete, head |
| `server/src/backups.ts` | Backup/restore engine: streaming tar.gz create, list/download/delete, filtered restore |
| `server/src/analytics.ts` | Request analytics: classification middleware, minute-bucket aggregation, summary/timeseries/live endpoints |
| `server/src/routes.ts` | CRUD, SSE, query building |
| `server/src/auth.ts` | BetterAuth instance + `/me` handler + user management endpoints |
| `server/src/middleware.ts` | Auth extraction (BetterAuth sessions + claims), permission checks via rules |
| `server/src/rules.ts` | Rules engine: load/watch/validate rules.json, resolve filters, API routes, legacy compat |
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
| GET | `/databases` | List database names |
| DELETE | `/db/:database` | Delete database (admin, cannot delete `default`) |
| GET | `/collections` | List collection names (default db) |
| POST | `/collections/:col` | Create document (default db) |
| GET | `/collections/:col` | List/query documents (default db; `?fields=name,status`) |
| GET | `/collections/:col/:id` | Get document (default db) |
| PUT | `/collections/:col/:id` | Replace document (upsert, default db) |
| PATCH | `/collections/:col/:id` | Partial update (default db) |
| DELETE | `/collections/:col/:id` | Delete document (default db) |
| GET | `/collections/:col/sse` | SSE (collection/query, default db) |
| GET | `/collections/:col/:id/sse` | SSE (document, default db) |
| GET | `/collections/:col/permissions` | Get permission level (legacy compat, admin) |
| PUT | `/collections/:col/permissions` | Set permission level (legacy compat, admin) |
| GET | `/storage` | List bucket names (admin) |
| POST | `/storage/:bucket` | Upload file, auto-generated path |
| POST | `/storage/:bucket/*path` | Upload file to specific path |
| GET | `/storage/:bucket` | List files in bucket |
| GET | `/storage/:bucket/*path` | Download file |
| DELETE | `/storage/:bucket/*path` | Delete file |
| HEAD | `/storage/:bucket/*path` | File metadata headers |
| POST | `/backups` | Create backup (admin; `{type?, database?, collection?}`) |
| GET | `/backups` | List backups with manifests (admin) |
| GET | `/backups/:name` | Download backup archive (admin, `latest` alias) |
| DELETE | `/backups/:name` | Delete backup (admin) |
| POST | `/backups/:name/restore` | Restore from server backup (admin, RestoreOptions body) |
| POST | `/restore` | Restore from uploaded tar.gz (admin, `?options=<json>`) |
| GET | `/analytics/summary` | Activity totals, per-op breakdown, top collections (admin, `?hours=`) |
| GET | `/analytics/timeseries` | Per-minute request buckets (admin, `?minutes=&database=&collection=`) |
| GET | `/analytics/live` | Live request feed via SSE (admin) |
| GET | `/rules` | Get rules.json + readonly flag (admin) |
| PUT | `/rules` | Replace entire rules.json (admin, 409 if readonly) |
| PUT | `/rules/collections/:col` | Update single collection rule (admin, 409 if readonly) |
| * | `/db/:database/collections/...` | All collection routes for named database |
| POST | `/auth/sign-up/email` | Register (BetterAuth) |
| POST | `/auth/sign-in/email` | Login (BetterAuth) |
| POST | `/auth/sign-out` | Logout (BetterAuth) |
| GET | `/auth/me` | Current user (includes role + claims) |
| GET | `/auth/providers` | List enabled OAuth providers |
| GET | `/auth/users` | List users (admin, `?limit=&offset=`) |
| GET | `/auth/users/:id` | Get user by ID (admin) |
| PUT | `/auth/users/:id/role` | Set user role (admin) |
| PUT | `/auth/users/:id/claims` | Replace user claims (admin) |
| PATCH | `/auth/users/:id/claims` | Merge user claims (admin, null deletes key) |
| PUT | `/auth/users/:id/password` | Set user password (admin, revokes sessions) |
| POST | `/auth/request-password-reset` | Email reset link (or log it if no SMTP) |
| POST | `/auth/reset-password` | Complete reset with token |
| POST | `/auth/change-password` | Change own password (authenticated) |
| DELETE | `/auth/users/:id` | Delete user + sessions (admin) |
| POST | `/auth/sign-in/social` | OAuth redirect (BetterAuth) |
| GET | `/auth/callback/:provider` | OAuth callback (BetterAuth) |

## Database

Each database is a Postgres schema (`db_<name>`). Per-collection tables within each schema: `db_<name>.col_<col>(id TEXT PK, data JSONB, created_at BIGINT, updated_at BIGINT)` with GIN index on `data`. Auth managed by BetterAuth in the `public` schema (`user`, `session`, `account`, `verification` tables), shared across all databases. Users have `role` (TEXT, default `"user"`) and `claims` (TEXT, default `"{}"` — serialized JSON) columns.

Collection permissions are defined in `/data/rules.json` (one file per instance, covers all databases). Format:

Fresh instances default to `{"read": "public", "write": "authenticated"}`; the server warns at boot if the effective write default is `public`. Rule filters are enforced on writes too: creates auto-stamp missing single-value filter fields (owner's `userId` etc.) and reject mismatches; PATCH cannot move a doc out of the caller's filter scope.

```json
{
  "default": "public",
  "collections": {
    "feed": { "read": "public", "write": "authenticated" },
    "profiles": { "read": "public", "write": "owner" },
    "reports": {
      "read": { "access": "role:mover", "filter": { "orgId": "claims.orgIds" } },
      "write": "admin"
    },
    "user_notes": { "access": "authenticated", "filter": { "userId": "auth.id" } },
    "admin_dashboard": "admin",
    "public_feed": "public"
  },
  "buckets": {
    "avatars": { "read": "public", "write": "authenticated" },
    "documents": "owner",
    "public_assets": "public"
  }
}
```

Collections support **separate read/write permissions**. `read` and `write` each accept a string level or `{ access, filter? }` object. Write covers create, update, and delete. A plain string (e.g. `"authenticated"`) is shorthand that applies to both read and write. If only `read` or `write` is specified, the other falls back to `default`. `default` also supports `{ "read": "public", "write": "authenticated" }`.

Permission levels: `public`, `authenticated`, `admin`, `owner` (sugar for `{ access: "authenticated", filter: { userId: "auth.id" } }`), `role:<name>` (requires matching role). Filter maps doc fields to auth context (`auth.id` = user ID, `claims.*` = claim values). Array claims use SQL `ANY()`, multiple filter keys are AND'd.

## Releasing

Automatic on merge to master, major.minor versioning (minor bumps per release). GitHub Actions detect what changed:
- `sdk/**` changed → bumps SDK minor version, publishes to npm as `@ezwrld/ezbase`, tags `sdk-vX.Y.0` (npm requires three-part semver; patch stays 0)
- `server/**`, `console/**`, `nginx/**`, `docker/**`, `Dockerfile` changed → bumps image minor version, pushes to GHCR as `ghcr.io/ezwrld/ezbase`, tags `vX.Y`

**Every release PR must add a `CHANGELOG.md` entry** — `## vX.Y — date` with an **Upgrade considerations** section ("None." if none); breaking changes require a new major version and a **⚠ BREAKING** section. The image workflow auto-creates a GitHub Release from the entry. `/api/health` reports the running version (baked in at image build).

Controlling versions explicitly:
- **Image**: run the "Publish Docker image" workflow manually (workflow_dispatch) with an exact `version` input (e.g. `1.0`) — it builds, tags `v1.0`, and future merges auto-bump from there.
- **SDK**: `sdk/package.json` is authoritative — set it to any unpublished version and the workflow publishes it as-is; otherwise it auto-bumps minor.
