# Architecture Decisions & Roadmap

## 1. Environments (decided)

**One ezbase instance = one environment.** Each environment is its own Docker container with its own Postgres, its own auth system, its own file storage. Environments are fully isolated.

Different environments = different URLs. The SDK connects to one environment at a time:

```typescript
const ez = new EzBase({
  name: 'production',                    // optional, defaults to 'default'
  url: 'https://ezbase.myapp.com',
  adminKey: process.env.EZBASE_ADMIN_KEY,
})
```

`name` is optional (defaults to `'default'`), recommended for clarity. It shows up in error messages and logs so you always know which environment you're talking to. No config files, no environment abstractions — just a URL and an optional label.

For PR previews, local dev, staging: spin up a container per environment. The SDK code stays the same, only the URL changes.

## 2. Multiple Databases (done)

**One environment can have multiple databases.** Each database is an isolated set of collections. Auth is shared across all databases in the environment.

### Why

Real use case: a moving company app has shared data (users, global config) and campus-specific data (auburn orders, oxford orders). Without multi-db, every document needs a `campus` field and every query needs a campus filter. With multi-db, the data is structurally separated — same collection names, completely isolated data.

### How it works

Databases auto-create on first write. Each database is a Postgres schema (`db_<name>`). Collections within each schema: `db_<name>.col_<col>`. Auth stays in the `public` schema, shared across all databases.

API: legacy `/api/collections/...` routes target `default` database. Named database routes at `/api/db/:database/collections/...`. SDK: `ez.database('auburn').collection('orders')`. `ez.collection('x')` is sugar for `ez.database('default').collection('x')`.

## 3. Admin SDK (done)

Same SDK, admin methods. The admin key in the constructor signals intent.

```typescript
const ez = new EzBase({ url: '...', adminKey: '...' })
await ez.setPermission('todos', 'authenticated')
await ez.getPermission('todos')
await ez.listDatabases()
await ez.listCollections()
await ez.getRules()
await ez.setRules({ default: 'public', collections: { ... } })
```

## 4. Declarative Rules — rules.json (done)

Single `rules.json` file per instance (covers all databases). Replaces the old `_ezbase_config` Postgres table.

- **Access levels:** `public`, `authenticated`, `admin`, `owner`, `role:<name>`
- **Document filters:** Map doc fields to auth context (`auth.id`, `claims.*`)
- **Bucket permissions:** Same access levels for file storage
- **Hot-reload:** File watched with 200ms debounce, changes picked up without restart
- **Read-only mode:** Mounted files detected automatically, console shows read-only banner
- **Console editor:** Rules page with JSON editor, validation, save/load
- **Legacy compat:** `setPermission()` / `getPermission()` routes still work, write to rules.json

## 5. File Storage (done)

On-disk files (Docker volume at `/data/files`) + metadata in Postgres (`_ezbase_files`).

- Upload/download/delete/list via REST
- Bucket permissions via `rules.json` `buckets` section
- Owner mode: only uploader can read/delete
- Auto-generated or specific file paths
- Max file size configurable (default 100MB)
- SDK: `ez.storage('bucket').upload()/.list()/.file().download()/.delete()`

## 6. Auth — BetterAuth (done)

- Email/password with session tokens
- OAuth providers (Google, GitHub, Microsoft, Apple) — enabled by env vars
- Account linking for trusted providers
- Custom `role` and `claims` fields on users
- Admin user management endpoints (`/auth/users/*`)
- Shared across all databases

## 7. Console Admin Gate (done)

Console gated behind admin key. One login screen, stored in localStorage, passed to every API call. To rotate: change `ADMIN_KEY` env var and restart.

## 8. Declarative Rules — ezbase.json (future)

A rules file that lives in your project, version-controlled, applied on deploy. Paves the way for:
- **Field-level rules**
- **Per-database defaults**

Not building this yet. Current permission system (rules.json with read/write split) works.

## 9. Atomic Document Operations (next)

The current document API gives each create/update/delete one atomic SQL statement, but it does not expose a public transaction or compare-and-set primitive. That means app code can still hit race conditions when it needs to read a document, make a decision, and write back only if nobody changed it first.

Add a small atomic-update surface before building higher-level primitives on top:

- **Revision field:** every document gets an internal revision/version.
- **Compare-and-set update:** update a document only if its current revision, status, or field value still matches an expected value.
- **Atomic increment/merge helpers:** common single-document mutations without a read/modify/write race.
- **Optional transaction API:** only if compare-and-set does not cover real app needs.

This is also the foundation for durable queues. A queue worker must be able to claim a pending job exactly once, even when multiple workers or blue/green app versions are running.

## 10. Durable Queues (next)

Queues should be built into ezbase without requiring Redis. For the single-VPS target, Postgres is already the durable coordination layer.

The minimum useful queue is not Redis-style throughput; it is atomic claiming:

```typescript
await ez.queue('booked_move').publish({
  type: 'send_customer_confirmation',
  payload: { moveId },
})

await ez.queue('booked_move').work(async (job) => {
  await sendCustomerConfirmation(job.payload.moveId)
})
```

Under the hood, queue jobs can still be represented as documents, but claims must be handled by a purpose-built atomic operation:

```text
pending -> running -> completed
                 -> retrying
                 -> failed
```

Required v1 semantics:

- Publish a job document with `status`, `type`, `payload`, `runAt`, `attempts`, and timestamps.
- Claim one pending job atomically, setting `status = running`, `lockedBy`, `lockedUntil`, and incrementing attempts.
- Use a lease timeout so jobs recover if a worker dies during deploy.
- Mark jobs complete or failed from the worker harness.
- Support delayed jobs and simple retry/backoff.
- Expose queue state in the console for debugging and manual retry.
- Use LISTEN/NOTIFY as a wakeup optimization, with polling as the correctness fallback.

Redis/BullMQ becomes useful when queue traffic needs separate infrastructure, very high sustained throughput, or advanced scheduling/fanout behavior. For ezbase's target, a Postgres-backed queue should handle normal SaaS workloads and removes another service from the stack.

## 11. Search (next)

Add search out of the box. Start with the least operational complexity that satisfies common app needs:

1. **Postgres full-text search first** for simple text search over selected fields.
2. **Meilisearch optional later** when typo tolerance, ranking, faceting, or richer search UX justifies the extra process and memory.

The SDK should expose one search API either way:

```typescript
const results = await ez.collection('bookings').search('packing supplies', {
  fields: ['customerName', 'notes'],
  limit: 20,
})
```

---

## Implementation Order

1. ~~**Multi-database support** — schema isolation, route changes, SDK `database()` method, migration~~ **Done**
2. ~~**Admin SDK methods** — `setPermission`, `getPermission`, `listCollections`, `listDatabases`, `getRules`, `setRules`~~ **Done**
3. ~~**SDK `name` param** — optional connection name, included in error messages~~ **Done**
4. ~~**Declarative rules** — `rules.json`, access levels, claim-based document filters, bucket permissions~~ **Done**
5. ~~**File storage** — on-disk files, metadata in Postgres, bucket permissions, SDK integration~~ **Done**
6. ~~**Auth: OAuth providers** — Google, GitHub, Microsoft, Apple via BetterAuth, account linking~~ **Done**
7. ~~**Auth: Custom claims** — role + claims fields, admin user management endpoints~~ **Done**
8. ~~**Console admin gate** — login screen, key rotation, all API calls authenticated~~ **Done**
9. ~~**Separate read/write permissions** — `rules.json` with `read` / `write` rule keys~~ **Done**
10. **Backups** — automated pg_dump, off-box object storage, restore drills
11. **Atomic document operations** — revision/compare-and-set updates, mutation helpers
12. **Durable queues** — Postgres-backed job documents with atomic claim, leases, retries, console visibility
13. **Search** — Postgres full-text search first, optional Meilisearch integration later
14. **Observability** — request metrics, auth analytics, console dashboard
