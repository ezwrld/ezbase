# Architecture Decisions & Roadmap

## 1. Environments (decided)

**One ezbase instance = one environment.** Each environment is its own Docker container with its own Postgres, its own auth system, its own file storage (when built). Environments are fully isolated.

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

## 2. Multiple Databases (decided)

**One environment can have multiple databases.** Each database is an isolated set of collections. Auth is shared across all databases in the environment.

### Why

Real use case: a moving company app has shared data (users, global config) and campus-specific data (auburn orders, oxford orders). Without multi-db, every document needs a `campus` field and every query needs a campus filter. With multi-db, the data is structurally separated — same collection names, completely isolated data.

### How it works for the user

Databases auto-create on first write, just like collections:

```typescript
const ez = new EzBase({ url: 'http://localhost:7003' })

// Default database — most projects only ever use this
await ez.collection('todos').add({ title: 'Ship it' })
// ↑ shorthand for ez.database('default').collection('todos')

// Named databases — isolated document stores, shared auth
const auburn = ez.database('auburn')
const oxford = ez.database('oxford')

await auburn.collection('orders').add({ customer: 'Alice', total: 250 })
await oxford.collection('orders').add({ customer: 'Bob', total: 180 })
// These are completely separate tables — no cross-contamination

// Auth is environment-level, not database-level
await ez.auth.signIn({ email, password })
// ↑ same user can access any database (subject to permissions)

// Permissions are per-database-per-collection
// auburn's 'orders' can be public while oxford's 'orders' is admin-only
```

No explicit "create database" step. No SQL. No config. You just use it.

### How it works on the server

**Postgres schemas** provide real isolation:

```
public schema     → BetterAuth tables (user, session, account, verification)
db_default schema → col_* tables, _ezbase_config (default database)
db_auburn schema  → col_* tables, _ezbase_config (auburn database)
db_oxford schema  → col_* tables, _ezbase_config (oxford database)
```

Each database is a Postgres schema. Schemas are created on demand, same as collection tables today. Auth stays in the `public` schema, shared across all databases.

**Server changes required:**

| File | Change |
|------|--------|
| `db.ts` | Add `ensureDatabase(name)` — `CREATE SCHEMA IF NOT EXISTS db_<name>`, cached in a Set like `ensureCollection`. Update `ensureCollection` to accept a database param and create tables within the schema. |
| `routes.ts` | Extract database from URL param. All SQL queries prefix table references with the schema (`db_<name>.col_<collection>`). Add `/api/db/:db/collections/...` routes alongside existing `/api/collections/...` (which maps to `default`). |
| `middleware.ts` | `getPermissionLevel` becomes schema-aware — reads from `db_<name>._ezbase_config` instead of `public._ezbase_config`. |
| `permissions.ts` | Same — schema-qualified permission reads/writes. |
| `pubsub.ts` | Change events include database name: `{ type, id, collection, database }`. SSE subscriptions filter by database + collection. |
| `index.ts` | Mount new `/api/db/:db/...` routes. |

**API routes:**

```
# Default database (backward compatible)
POST   /api/collections/:col           → db_default.col_<col>
GET    /api/collections/:col           → db_default.col_<col>
...

# Named database
POST   /api/db/:db/collections/:col    → db_<db>.col_<col>
GET    /api/db/:db/collections/:col    → db_<db>.col_<col>
...

# Database management (admin only)
GET    /api/databases                   → list all databases
DELETE /api/db/:db                      → drop database (destructive, admin only)
```

**SDK changes:**

```typescript
// ez.database(name) returns a DatabaseRef — same API as the top-level client for collections
const db = ez.database('auburn')
db.collection('orders').add(...)
db.collection('orders').get()
db.collection('orders').where(...).onSnapshot(...)

// ez.collection('x') is sugar for ez.database('default').collection('x')

// Admin methods
await ez.listDatabases()  // ['default', 'auburn', 'oxford']
```

**Database name rules:** Same as collection names — `[a-zA-Z][a-zA-Z0-9_]{0,62}`, no `_ezbase_` prefix.

### What doesn't change

- Auth flow — BetterAuth stays in public schema, completely unaware of databases
- Middleware — still extracts role the same way, just checks permissions in the right schema
- Collection CRUD logic — identical, just schema-qualified
- SSE/pubsub — LISTEN/NOTIFY works across schemas (same Postgres instance)
- SDK auth methods — `ez.auth.signUp/signIn/signOut` unchanged

### Migration from current state

Current tables (`col_*` in public schema) move to `db_default` schema. One-time migration on server startup: detect if `col_*` tables exist in public schema, move them to `db_default`. Existing `/api/collections/...` endpoints keep working — they just route to default.

## 3. Admin SDK (decided)

**Same SDK, add admin methods.** No separate package or class.

The admin key in the constructor already signals intent. Adding a separate package for a handful of methods is over-engineering.

### Methods to add

```typescript
const ez = new EzBase({ url: '...', adminKey: '...' })

// Permission management (already works via REST, needs SDK wrappers)
await ez.setPermission('todos', 'authenticated')            // default db
await ez.database('auburn').setPermission('orders', 'admin') // named db
await ez.getPermission('todos')

// Database management
await ez.listDatabases()
await ez.listCollections()                  // default db
await ez.database('auburn').listCollections()
```

## 4. Declarative Rules — ezbase.json (future)

A rules file that lives in your project, version-controlled, applied on deploy:

```json
{
  "rules": {
    "default": "deny",
    "databases": {
      "default": {
        "collections": {
          "public_feed": { "read": "allow", "write": "authenticated" },
          "user_notes": { "read": "owner", "write": "owner" },
          "admin_config": { "read": "admin", "write": "admin" }
        }
      },
      "auburn": {
        "default": "authenticated",
        "collections": {
          "public_info": { "read": "allow" }
        }
      }
    }
  }
}
```

Paves the way for:
- **Separate read/write permissions** (currently one level for both)
- **Owner rules** — `"owner"` means `data.userId == auth.uid`
- **Field-level rules**
- **Per-database defaults**

Not building this yet. Current permission system works. The rules file is the path forward once the multi-database foundation is in place.

## Implementation Order

1. ~~**Multi-database support** — schema isolation, `ensureDatabase`, route changes, SDK `database()` method, migration of existing tables to `db_default`~~ **Done**
2. ~~**Admin SDK methods** — `setPermission`, `getPermission`, `listCollections`, `listDatabases`~~ **Done**
3. ~~**SDK `name` param** — optional connection name, included in error messages~~ **Done**
4. **Declarative rules** — `ezbase.json`, separate read/write, owner rules
