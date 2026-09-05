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

Named databases are created on an admin's first write. Each database is a Postgres schema (`db_<name>`). Collections within each schema: `db_<name>.col_<col>`. Auth stays in the `public` schema, shared across all databases.

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
await ez.setRules({ default: 'admin', collections: { todos: 'authenticated', ... } })
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
10. **Backups** — automated pg_dump, point-in-time recovery
11. **Observability** — request metrics, auth analytics, console dashboard
