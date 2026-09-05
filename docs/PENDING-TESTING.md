# Pending Testing

Features built across recent sessions that need end-to-end testing before the next release.

---

## 1. Multi-Database Support

Multiple isolated databases per instance, each a Postgres schema (`db_*`), created on an admin's first write. Auth shared across all databases.

### What to test

- [ ] Create docs in `default` db via `/api/collections/:col` — works as before
- [ ] Admin creates docs in named db via `/api/db/:database/collections/:col` — schema auto-created; non-admin gets 404 for a missing database
- [ ] `GET /api/databases` returns list including `default` and any created databases
- [ ] Collections in different databases are fully isolated (same collection name, different data)
- [ ] `DELETE /api/db/:database` drops schema (admin only, cannot delete `default`)
- [ ] SSE subscriptions are database-scoped (events in `auburn` don't fire callbacks in `oxford`)
- [ ] Console database selector dropdown works — switching databases shows different collections
- [ ] Admin SDK: `ez.database('auburn').collection('orders').add(...)` creates schema + table; a user-token SDK cannot create a missing named database
- [ ] SDK: `ez.listDatabases()` returns all databases
- [ ] SDK: `ez.database('auburn').listCollections()` returns only that db's collections
- [ ] Database name validation: rejects invalid names (`_ezbase_foo`, `public`, names with special chars)
- [ ] Migration: existing `col_*` tables in `public` schema move to `db_default` on startup

---

## 2. Auth — OAuth Providers

BetterAuth-powered OAuth sign-in (Google, GitHub, Microsoft, Apple). Enabled by setting env vars — zero code changes.

### What to test

- [ ] Email/password sign-up + sign-in still works (regression)
- [ ] `GET /api/auth/providers` returns correct list based on configured env vars
- [ ] OAuth redirect flow: `signInWithProvider('google')` → redirects to Google → callback → session created
- [ ] After OAuth redirect, `ez.auth.getSession()` restores the session with correct user data
- [ ] Account linking: sign up with email, then OAuth with same email → same user, two auth methods
- [ ] `ez.auth.currentUser` includes `role` and `claims` after OAuth sign-in
- [ ] Session tokens work across databases (auth is shared, not per-db)
- [ ] No providers configured → `listProviders()` returns `{ providers: [], emailPassword: true }`

### Env vars to set for testing

```
EZBASE_URL=http://localhost:7003
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
```

---

## 3. Custom Claims & User Management

Users have `role` (TEXT) and `claims` (JSON) fields. Admin endpoints for managing users, roles, and claims.

### What to test

- [ ] `setRole(userId, 'mover')` — user's role persists across sign-ins
- [ ] `setClaims(userId, { orgIds: ['auburn'] })` — replaces all claims
- [ ] `mergeClaims(userId, { tier: 'pro' })` — merges into existing claims
- [ ] `mergeClaims(userId, { orgIds: null })` — deletes the `orgIds` key
- [ ] `listUsers({ limit: 10, offset: 0 })` — paginated user list
- [ ] `getUser(userId)` — returns user with role + claims
- [ ] `deleteUser(userId)` — removes user, sessions, and accounts
- [ ] After sign-in, `ez.auth.currentUser.role` and `.claims` are populated correctly
- [ ] Admin can't delete their own account (self-deletion guard)
- [ ] Non-admin gets 401/403 on all user management endpoints

---

## 4. Rules.json — Declarative Permissions with Claim-Based Filtering

Single `rules.json` file replaces the per-database `_ezbase_config` Postgres table. Supports access levels + document filters based on user claims.

### What to test

#### Rules loading & management
- [ ] Fresh start: `/data/rules.json` created with `{ "default": "admin" }`
- [ ] `GET /api/rules` (admin) returns `{ rules: {...}, readonly: false }`
- [ ] `PUT /api/rules` replaces entire rules file
- [ ] `PUT /api/rules/collections/:col` updates a single collection rule
- [ ] Hot-reload: edit rules.json on disk → server picks up changes within seconds
- [ ] Invalid rules.json → server keeps previous rules, logs warning
- [ ] Non-admin gets 401/403 on rules endpoints

#### Simple access levels
- [ ] `"public"` — anonymous users can read/write
- [ ] `"authenticated"` — anonymous gets 401, signed-in users get full access
- [ ] `"admin"` — only admin key or admin-role users
- [ ] `"role:mover"` — only users with `role === 'mover'`
- [ ] `"owner"` — expands to userId filter, users only see their own docs
- [ ] Default level applies to unlisted collections

#### Claim-based document filters
- [ ] `{ "access": "authenticated", "filter": { "userId": "auth.id" } }` — same as `owner`
- [ ] `{ "access": "role:mover", "filter": { "orgId": "claims.orgIds" } }` with array claim → SQL `ANY()`
- [ ] `{ "access": "authenticated", "filter": { "orgId": "claims.orgId" } }` with string claim → equality
- [ ] Multiple filter keys → AND logic (both must match)
- [ ] Missing claim → 403 (user can't match any docs)
- [ ] Empty array claim → 403
- [ ] Nested claims: `"claims.org.id"` resolves correctly
- [ ] Admin key bypasses all filters (sees all docs)

#### Filter enforcement across CRUD + SSE
- [ ] `GET /collections/:col` — list only returns matching docs
- [ ] `GET /collections/:col/:id` — returns 404 for non-matching doc (not 403)
- [ ] `PUT /collections/:col/:id` — can't overwrite a doc that doesn't match filter
- [ ] `PATCH /collections/:col/:id` — can't update a doc that doesn't match filter
- [ ] `DELETE /collections/:col/:id` — can't delete a doc that doesn't match filter
- [ ] `POST /collections/:col` — allowed (no filter on creates)
- [ ] SSE collection stream — only includes matching docs in snapshots
- [ ] SSE document stream — returns null for non-matching doc

#### SDK integration
- [ ] `getRules()` returns current rules + readonly flag
- [ ] `setRules(rules)` replaces rules
- [ ] `setPermission('col', 'authenticated')` — legacy string still works
- [ ] `setPermission('col', { access: 'role:mover', filter: { orgId: 'claims.orgIds' } })` — object works
- [ ] `getPermission('col')` returns `{ database, collection, level }` (access string only)

#### Read-only mode (mounted file)
- [ ] Mount `rules.json` as read-only volume → `GET /api/rules` returns `readonly: true`
- [ ] `PUT /api/rules` returns 409
- [ ] `setPermission()` via SDK returns error
- [ ] Console rules editor shows read-only banner, textarea disabled

#### Console rules editor
- [ ] "Rules" button appears in sidebar
- [ ] Clicking it shows rules JSON immediately (console is already authenticated via app-level admin key gate)
- [ ] Editable textarea with client-side JSON validation
- [ ] "Save" button writes rules, shows success feedback
- [ ] Invalid JSON shows error inline, save button disabled

#### Migration / backward compat
- [ ] Existing `_ezbase_config` tables are dropped during migration
- [ ] Old SDK versions using `setPermission('col', 'admin')` still work via legacy routes

---

## End-to-End Scenario

The full flow that proves everything works together:

```bash
# 1. Start fresh
ez down --nuke && ez up

# 2. Check health
curl http://localhost:7003/api/health

# 3. Verify default rules
curl -H "Authorization: Bearer $ADMIN_KEY" http://localhost:7003/api/rules
# → { "rules": { "default": "admin" }, "readonly": false }

# 4. Set up rules with claim filter
curl -X PUT -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"default":"public","collections":{"orders":{"access":"role:mover","filter":{"orgId":"claims.orgIds"}}}}' \
  http://localhost:7003/api/rules

# 5. Create a user, assign role + claims
# (sign up, then use admin key to set role and claims)

# 6. Create docs with different orgIds
# (use admin key to create docs in "orders" collection)

# 7. Sign in as the user → GET /collections/orders
# → only docs matching their orgIds claim

# 8. Try with admin key → sees all docs

# 9. Open console → Rules page → verify rules are displayed
```

---

## Notes

- The `_ezbase_config` Postgres table is fully replaced by `rules.json`. Old tables are cleaned up during migration.
- Rules are per-instance (not per-database). One rules.json covers all databases and collections.
- The `RULES_PATH` env var controls the file location (default: `/data/rules.json`, dev: `/tmp/rules.json`).
