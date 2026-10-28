# Changelog

Patch notes and upgrade considerations for every ezbase release. **Agents: this is the file to read when you detect a version difference** — compare your instance's version (`GET /api/health` → `{ version }`) against the entries below before upgrading.

**The versioning promise:**

- Image releases use a simple two-part sequence: `v1.8`, `v1.9`, `v1.10`, `v1.11`, and so on. The right-hand number increments for every release; it is not semantic versioning.
- npm still requires three parts, so matching SDK versions use a trailing `.0` when applicable.
- Compatibility or behavior changes are called out in that release's **Upgrade considerations** instead of being encoded in the version number.
- Every entry has an **Upgrade considerations** section — "none" means none — and an **Agent prompt** so consuming apps can be told “update ezbase” without a custom brief.

Pin a release tag (`ghcr.io/ezwrld/ezbase:1.17`) to control when you take upgrades; `:latest` tracks the newest release.

---

## v1.17 — 2026-10-27

A Firebase-style console, data shapes, and index management.

### Added
- **Console redesign.** Collections sidebar with counts; a path bar of clickable segments that also takes typed paths (`games/mlb_stats:823031`, `otherdb/users/abc`); per-collection tabs in the URL:
  - **Documents** — live table of the newest documents and a document panel (field tree, copy, edit as JSON, delete).
  - **Query** — where / order by / limit builder with the equivalent SDK call, results with document count, query time, rows read vs returned, the index that served it, and **Add index** when none did.
  - **Indexes** — every index with kind (primary, built-in, declared, automatic, legacy), fields, size, and reads; declare and remove entries in `indexes.json`; drop legacy GIN indexes; suggestions from queries that ran without an index.
  - **Shapes** — every field's JSON types and presence as stacked bars, values of enum-like fields, nested fields, flagged inconsistencies, shapes per discriminating field, the derived TypeScript interface, and cleanup scripts.
  - The overview is a sortable, searchable collections table with document counts and data size.
- `GET /api/collections/:col/shapes` (admin): sampled shape analysis in Postgres — about 1 s on a 1.7M-document collection. Cleanup scripts use the SDK and handle nested fields and named databases.
- `GET /api/collections/:col/indexes`, `DELETE /api/collections/:col/indexes/:name` (legacy GIN only), `PUT /api/indexes/collections/:col` (writes `indexes.json`; 409 when it is mounted read-only).

### Changed
- `X-Ezbase-Index` reports `automatic <index>` when an index ezbase built for the query shape serves it, instead of `undeclared; add …`.

### Upgrade considerations
- None. To declare indexes from the console, `indexes.json` must be writable (not mounted `:ro`); mounted read-only, the Indexes tab shows them without the add button.

### Agent prompt
```
Update this project to ezbase 1.17 (image ghcr.io/ezwrld/ezbase:1.17). GET {ezbase}/api/health must report "1.17". No code changes.
```

---

## v1.16 — 2026-10-26

No automatic backup on upgrade.

### Removed
- The restore point written on a release's first boot (added in 1.13). Upgrades are protected by the release gate instead: every image must boot the previous release's data — a capitalized collection, 12,500 rows, a 2.2 MB document, a user with claims, a stored file, and an old backup — with every count, read, sign-in, file, and restore intact before it ships. Writing a database-sized archive on boot cost disk on hosts with multi-GB collections for no added protection. Existing `backup-…-upgrade-….tar.gz` files and `.backups/.version` are left in place and can be deleted.

### Upgrade considerations
- None.

### Agent prompt
```
Update this project to ezbase 1.16 (image ghcr.io/ezwrld/ezbase:1.16). GET {ezbase}/api/health must report "1.16". No code or settings changes.
```

---

## v1.15 — 2026-10-26

Upgrade restore points skip stored file bytes.

### Changed
- The restore point written on a release's first boot keeps documents, auth, rules, and file metadata, but not the bytes of stored files: an upgrade changes the database and never touches the file tree. On a production instance with 958 stored files it dropped from 518,734,437 bytes / 21 s to 63,497,756 bytes / 5.8 s; an instance holding 35 GB of video no longer writes a 35 GB archive per upgrade. Manual and API backups are unchanged and include file bytes.

### Upgrade considerations
- None.

### Agent prompt
```
Update this project to ezbase 1.15 (image ghcr.io/ezwrld/ezbase:1.15). GET {ezbase}/api/health must report "1.15". No code changes.
```

---

## v1.14 — 2026-10-26

The admin key reads everything it asks for; documents up to 16 MB.

### Changed
- **Admin reads are uncapped.** With the admin key, a list without `limit` returns every match and a `limit` returns exactly that many, at any size. Results larger than 10000 rows stream from a Postgres cursor 1000 rows at a time, so the server holds one batch: 716,622 documents (495 MB) streamed in 2.6 s with the container at 441 MB. Aggregates with the admin key return every group.
- **Other callers get up to 10000 (`EZBASE_MAX_LIMIT`), never a cut result.** Without `limit`, every match up to 10000, then a 400 (`More than 10000 documents match. Pass limit …`). A `limit` above 10000 is a 400 (`limit must be at most 10000`).
- **Realtime (`onSnapshot`/SSE)** re-sends its whole result on every change, so it stays capped at 10000 for everyone, with the same 400.
- **Documents may be up to 16 MB** (was 1 MB), matching the image's nginx request limit. `EZBASE_MAX_JSON_BYTES` still overrides.
- `EZBASE_DEFAULT_LIMIT` is removed; there is no separate default page size.

### Upgrade considerations
- From 1.13: an admin list without `limit` that used to 400 above 100 matches now returns everything. A browser/user list without `limit` returns up to 10000 instead of a 400 above 100.
- Remove `EZBASE_DEFAULT_LIMIT` and any `EZBASE_MAX_LIMIT` / `EZBASE_MAX_JSON_BYTES` raised to work around the old caps; they are no longer needed.

### Agent prompt
```
Update this project to ezbase 1.14 (image ghcr.io/ezwrld/ezbase:1.14). GET {ezbase}/api/health must report "1.14".

1. Remove EZBASE_DEFAULT_LIMIT, and EZBASE_MAX_LIMIT / EZBASE_MAX_JSON_BYTES if they were raised to get around ezbase's caps.
2. Server code using the admin key can drop paging loops and huge limits that only existed to read a whole result; a read without limit now returns every match.
3. Browser/user reads and onSnapshot: if one can match more than 10000 documents, pass a limit and page with offset — it returns a 400 otherwise.
4. Deploy. The first boot writes `restore point backup-…-upgrade-1.14.tar.gz` (server log); copy it off the host.
```

---

## v1.13 — 2026-10-26

No silent partial results, and a restore point on every upgrade.

### Changed
- **A query never returns a silently cut result.** Without a `limit`, a list, `onSnapshot`, or aggregate returns every match when there are at most 100 (`EZBASE_DEFAULT_LIMIT`) and a **400** when there are more: `More than 100 documents match. Pass limit (at most 10000) and page with offset, or narrow the where clause.` A `limit` above 10000 (`EZBASE_MAX_LIMIT`) is a 400 when more than 10000 match, instead of quietly returning 10000. An explicit `limit` up to the max behaves as before. Since 1.7 these cases returned the first 100 / 10000 rows with no signal: on one production app, a 44,355-row ledger read would have come back as 100 rows.
- A realtime subscription checks its first snapshot before streaming, so the 400 carries the message. If a live subscription later grows past its cap, it receives an `error` event and closes; the SDK passes the message to `onSnapshot`'s error callback.
- `GET` of a document that does not exist (404) no longer counts as an error in analytics; it is an answer.
- Console: the document table asks for the newest 100 explicitly, and the header shows the collection's real document count (it showed the loaded row count, e.g. "100 documents" for 716,622).

### Added
- **Restore point on upgrade.** The first boot of a new release on a volume with data writes a full backup `backup-<timestamp>-upgrade-<version>.tar.gz` in the background (2.67M documents: 143 MB in 108 s while serving) and records the version in `.backups/.version`. Reboots of the same release do nothing; the newest three upgrade backups are kept. A failed attempt retries on the next boot.

SDK `@ezwrld/ezbase` 1.8.0: realtime connection errors carry the server's message.

### Upgrade considerations
- Code that lists, subscribes to, or aggregates more than 100 matches **without** `limit` now gets a 400 where it used to get the first 100 silently. Pass the `limit` you mean (up to 10000) and page with `offset`. Instances that set `EZBASE_DEFAULT_LIMIT` higher keep returning up to that many without error.
- Booting 1.13 the first time writes a full backup to the data volume. Allow disk for one archive (roughly the compressed size of your data plus files).

### Agent prompt
```
Update this project to ezbase 1.13 (image ghcr.io/ezwrld/ezbase:1.13, SDK @ezwrld/ezbase 1.8.0). GET {ezbase}/api/health must report "1.13".

1. Before deploying, find every list/query `.get()`, `onSnapshot`, `.aggregate()`, and raw `GET /collections/:col` or `/sse` call without a `limit`, and every `limit` above 10000. For each, check the collection's real size (GET /api/collections/:col/stats with the admin key). If it can match more than 100 (or 10000) documents, pass the limit you actually want and page with offset — or keep reading everything by setting EZBASE_DEFAULT_LIMIT / EZBASE_MAX_LIMIT on the ezbase container. Do not leave a call that relied on the silent cut.
2. Confirm the data volume has free space for one full backup.
3. Pin the image and deploy. The server log shows `restore point backup-…-upgrade-1.13.tar.gz` within a few minutes; copy that file off the host.
4. Watch for 400s mentioning "documents match" in the app's logs for a day and fix each call site.
```

---

## v1.12 — 2026-10-25

Collections with capital letters in their names work everywhere.

### Fixed
- **Listing, querying, aggregating, and restoring a collection whose name has capitals (`bookingFormVisits`) failed** with `relation "db_default.col_bookingformvisits" does not exist`. Hand-built SQL used the name unquoted, so Postgres lowercased it while the table had been created with its real case. Writes and single-document reads were unaffected, so data kept accumulating; backups contained it but could not be restored. Lists have failed since 1.7; restore since backups shipped.
- Automatic and declared index builds on such collections failed the same way; they now build.
- A failed automatic index build now drops its invalid index (the drop named the index without its schema and never matched).

### Upgrade considerations
- None. No data changes; tables created by any earlier version are read as-is.
- Backups taken by earlier versions restore on 1.12, including their capitalized collections.

### Agent prompt
```
Update this project to ezbase 1.12 (image ghcr.io/ezwrld/ezbase:1.12). GET {ezbase}/api/health must report "1.12".

1. Take a backup first (POST /api/backups with the admin key) and copy it off the host.
2. Pin the image and redeploy.
3. If any collection name has capital letters, list it once with the admin key; it must return documents instead of a 500.
```

---

## v1.11 — 2026-10-21

Declared indexes and a query-by-query index report.

### Added
- **`/data/indexes.json`** (`INDEXES_PATH`): `{ "collections": { "<name>": { "indexes": [{ "equals": [...], "orderedBy": "..." }] } } }`. ezbase builds each declared index with `CREATE INDEX CONCURRENTLY` in the background, one at a time, then `ANALYZE`. It reloads when the file changes and drops an index whose entry is removed. A collection created later gets its declared indexes on creation. A declared shape the auto-indexer already built is adopted (same name and definition), not rebuilt.
- **`X-Ezbase-Index`** on every list and aggregate response: `declared {...}`, `built-in created|updated`, `undeclared; add {...}` with the exact entry to declare, or `full scan`. **`Server-Timing: db;dur=…`** carries the query time. Both are exposed to browsers via CORS.
- **Explain**: with the admin key, `X-Ezbase-Explain: 1` (SDK `query.explain()`) runs EXPLAIN ANALYZE and returns `X-Ezbase-Plan: index=…; read=…; returned=…; ms=…`.
- **`GET /api/indexes`** (SDK `ez.indexes()`): every declared index in every database with state (`ready`, `building`, `queued`, `no collection`), size and reads.

### Changed
- Admin queries whose shape a declared index already serves no longer trigger automatic index creation.
- Automatic and declared indexes share one definition builder (`indexDefinition`), so their names and SQL match.

### Upgrade considerations
- None. Without `indexes.json` everything behaves as in 1.10, plus the new response headers.
- Mount `indexes.json` read-only next to `rules.json` (`./indexes.json:/data/indexes.json:ro`). To migrate, declare the shapes your app actually runs; entries matching existing automatic indexes are adopted in place.

### Agent prompt
```
Update this project to ezbase 1.11 (image ghcr.io/ezwrld/ezbase:1.11, SDK @ezwrld/ezbase 1.7.0). GET {ezbase}/api/health must report "1.11".

1. Create indexes.json next to rules.json and mount it at /data/indexes.json (read-only).
2. For each query shape the app runs (where ==/in fields + orderBy or range field), add { "equals": [...], "orderedBy": "..." } under its collection.
3. Run each important query once with .explain() (admin key): it must say `declared {...}` and plan.read should be close to plan.returned. Add any `undeclared; add {...}` entry it suggests.
4. GET /api/indexes: every entry should reach state "ready".
```

---

## v1.10 — 2026-10-19

Aggregation, `in`, and nested fields — querying that uses Postgres instead of fighting jsonb.

### Added
- **`POST /collections/:col/aggregate`** and SDK `.aggregate()`: `groupBy` (up to 8 fields), `count`, `countDistinct`, `sum`, `avg`, `min`, `max`, `having`, `orderBy` an output or group field (nulls last), `limit`/`offset`. Numeric functions read JSON numbers and skip strings/nulls. Same read rules and filters as a list; 15s statement timeout per aggregate.
- **`in` operator**: an array of up to 10000 values, or a subquery on another collection in the same database (`where('gameId', 'in', games.where('season', '==', 2026))`) that runs inside the same statement. Subqueries need read access to their collection and apply its rule filters.
- **Dotted paths** in `where`, `orderBy`, `groupBy`, and aggregate fields (`stats.rushingYards`, `conference.abbreviation`). Automatic indexes match nested expressions.

### Changed
- **Automatic indexes build with `CREATE INDEX CONCURRENTLY` in the background**, then `ANALYZE` the table. A new query shape no longer blocks writes to a live table while its index builds, and the triggering query no longer waits for it. A failed build drops its invalid index instead of leaving it for `IF NOT EXISTS` to skip forever; the next server start retries it.
- **One automatic index per query shape.** Fields covered by a composite index no longer also get their own single-field index. Unordered reads (aggregates, subqueries) with two or more equality filters get an equality-only composite. Existing indexes are untouched.
- **No GIN index on new collections while auto-indexing is on (the default).** Those queries compare `data->'field'` expressions against btrees and never used the GIN. `EZBASE_GIN_EXCLUDE` is removed. With `EZBASE_AUTO_INDEX=false`, every collection still gets its GIN for `@>` containment.
- Unknown `where` operators return 400. They were silently treated as `==`.

### Upgrade considerations
- Clients sending an operator other than `== != < > <= >= in` now get a 400 instead of an equality match. Fix the operator.
- `.` in a `where`/`orderBy` field now means a nested path; such fields were rejected before. `?fields=`/`.select()` stay top-level.
- Indexes from earlier versions are left in place, including each collection's `idx_<db>_<col>_data` GIN. Every write maintains them. With auto-indexing on, review `pg_stat_user_indexes` for `idx_scan = 0` (GINs especially) and drop unused ones with `DROP INDEX CONCURRENTLY`.
- `EZBASE_GIN_EXCLUDE` no longer does anything; remove it from your environment.

### Agent prompt
```
Update this project to ezbase 1.10 after the image is published.

1. Pin ghcr.io/ezwrld/ezbase:1.10 (and @ezwrld/ezbase SDK 1.6.0). GET {ezbase}/api/health must report "1.10".
2. Search for where clauses using operators other than == != < > <= >= and fix them; they now return 400.
3. Replace client-side reductions over fetched documents (sums, counts, leaderboards, group-bys) with .aggregate(), and replace fetch-ids-then-filter round trips with an `in` subquery.
4. Run important query and aggregate shapes once with an admin client; their indexes now build concurrently in the background.
5. Remove EZBASE_GIN_EXCLUDE from the environment. Do not drop existing indexes without the owner's approval; list `idx_scan = 0` indexes for them instead.
```

---

## v1.9 — 2026-09-05

Secure-by-default lazy collection creation.

### Changed
- **Fresh instances deny by default.** New `/data/rules.json` files contain `{ "default": "admin" }`. Rules whitelist client-visible names but do not define tables or fields.
- The first permitted `POST`/`PUT` still creates a collection automatically. Reads, subscriptions, PATCH, DELETE, and stats requests never create missing tables.
- A non-admin first write requires an explicit collection rule, even if the fallback permits writes.
- Only an admin write may create a named database, and only admin queries may create automatic JSON field/composite indexes.

### Fixed
- The all-in-one image no longer overwrites the server's secure default with the legacy `{ "default": "public" }` on first boot.
- Anonymous or ordinary authenticated callers can no longer manufacture unbounded schemas, tables, and indexes through guessed route/query names.

### Upgrade considerations
- Existing `/data/rules.json` files are preserved. Audit them manually; upgrading does not replace an existing public/authenticated fallback. Keep `default: "admin"` and add exact entries for client-visible collections and buckets.
- Collection auto-creation remains. If a user client relied on a broad fallback to create a previously unseen collection, add an explicit rule for that name; do not pre-create its table.
- If a user client created named databases, seed each database once with an admin write. User writes continue normally after the database exists.
- Reading a missing collection now returns empty/null without creating it. Run important query shapes once through an admin client to warm automatic indexes.

### Agent prompt
```
Update this project to ezbase 1.9 after the image is published.

1. Back up the instance and pin ghcr.io/ezwrld/ezbase:1.9. GET {ezbase}/api/health must report "1.9".
2. Audit rules.json: keep default "admin" and explicitly list client-visible collections/buckets. These rules are only an access whitelist; permitted writes still create collection tables automatically.
3. If user clients previously created named databases, seed each with one admin-key write.
4. Warm important where/orderBy shapes with an admin client so their automatic indexes exist.
```

---

## v1.8 — 2026-08-25

Auth setup in the console.

### Added
- **Console → Auth.** Set the public URL and turn on Google / GitHub / Microsoft / Apple by pasting client ID + secret. Callback URL is shown to copy. Saved to `/data/auth.json`. Takes effect without a restart.
- **Console → Auth users table.** Email, UID, providers, created, last signed in, role. `GET /api/auth/users` includes `providers` (`password` / `google` / …) and `lastLogin`.
- **Auth origin** field — host only (`https://app.whatever.com`), for when the app is on a different host than ezbase. Same host as the public URL is already allowed.
- Console pages have URLs (`/console/auth`, `/activity`, …) so a refresh stays on that page.

### Changed
- OAuth providers are configured in the console, not `GOOGLE_*` env vars.
- `EZBASE_URL` is only “how this process is mounted” (including `/ez`). It is not a second copy of trusted origins.
- Full backups include `auth.json`.
- `listUsers` / `getUser` include optional `providers` and `lastLogin`.

### Fixed
- Vite HMR uses the page’s port instead of hardcoding 7003.
- Console collection routes pass the strict production TypeScript build.

### Upgrade considerations
- None if you already use Console → Auth. If you had `GOOGLE_*` in compose, paste those into Console → Auth once and delete the env vars.
- If the public URL includes a path (`/ez`) that you change, restart once so the process mount matches.
- Aura: keep `EZBASE_URL=https://aura.tl/ez` (or local equivalent) so the container serves `/ez`. Do not set `EZBASE_TRUSTED_ORIGINS`. Add Google in the console.

### Agent prompt
```
Update this project to ezbase 1.8.

1. Pin ghcr.io/ezwrld/ezbase:1.7 → 1.8 after the image is published. GET {ezbase}/api/health must report "1.8".
2. SDK: optional `providers` and `lastLogin` on listUsers/getUser. Pin if the workflow published a new @ezwrld/ezbase.
3. OAuth: open {ezbase}/console → Auth. Public URL is the ezbase URL including /ez if you mount there (Aura: https://aura.tl/ez). Paste provider credentials, copy the callback into Google/GitHub. Do not set GOOGLE_* or EZBASE_TRUSTED_ORIGINS. Same-host /ez does not need extra origins. The users table is on that page.
```

---

## v1.7 — 2026-08-25

Query performance.

### Added
- Automatic btree indexes for JSON `where` / `orderBy` fields (and composites of up to three equality filters + the sort). First request of a new shape builds the index; later requests are index scans. `EZBASE_AUTO_INDEX=false` keeps the old GIN containment predicates.
- btree on `updated_at` for every collection (same as `created_at`).

### Fixed
- List/query/SSE always apply a limit. Default 100, max 10000 (`EZBASE_DEFAULT_LIMIT` / `EZBASE_MAX_LIMIT`), **including admin-key callers**. `limit=0` or negative is `400`.
- Numeric ranges (`startsAtMs >= x`) and JSON equality use jsonb compare so the new indexes are actually chosen.

SDK unchanged (still `@ezwrld/ezbase@1.4.0` unless we bump).

### Upgrade considerations
- **Always pass `limit` on list/query/SSE.** Admin key no longer returns an entire collection. If you needed more than 10000 rows in one call, raise `EZBASE_MAX_LIMIT` or page with `offset`.
- First query of each new filter/sort shape on a large collection will stall while Postgres builds the index (seconds at ~500k docs; minutes possible at millions). After that it stays fast. You can warm indexes by running your real queries once after deploy.
- No query API change. `where` + `orderBy` + `limit` is the fast path. Nested fields (`game.sport`) are still rejected.
- `EZBASE_GIN_EXCLUDE` still skips the full-document GIN on fat collections. Field btrees still apply.

### Agent prompt
Paste this to the app that consumes ezbase (Aura, etc.):

```
Update this project to ezbase 1.7.

1. Read https://raw.githubusercontent.com/ezwrld/ezbase/master/CHANGELOG.md — the v1.7 entry.
2. Pin the image to ghcr.io/ezwrld/ezbase:1.7 (compose / fly / whatever runs ezbase). Restart. GET {ezbase}/api/health must report "1.7".
3. SDK: stay on @ezwrld/ezbase@1.4.0 unless the changelog says otherwise. No client API change.
4. Every list/query/onSnapshot must pass limit (you probably already do). Admin key is no longer unlimited — a missing limit returns 100 docs, max 10000.
5. After deploy, hit your real queries once (pending jobs, date-range games, orderBy updated) so indexes build. Expect a one-time delay on big collections.
6. Do not dump whole collections. Do not mix an unbounded audit log and a job queue in the same collection if both are huge — that is an app data-model issue, not an ezbase query rewrite.
```

## v1.6 — 2026-08-25

### Fixed
- **Collection listing is permission-aware.** `GET /api/collections` (and the named-db equivalent) only returns collections the caller can read. Admin-only collections no longer leak their names to anonymous clients.
- **`GET /api/databases` is admin-only.**
- **File downloads cannot execute in the ezbase origin.** Downloads send `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`.
- **`orderBy` on JSON numbers is numeric.** Previously `data->>'field'` sorted as text (`99` before `199`). Sorts now use jsonb comparison so numbers compare as numbers.
- **SDK auth from Node/Bun.** `@ezwrld/ezbase` sends `Origin` on auth POSTs. BetterAuth CSRF was rejecting sign-up/sign-in without it (`MISSING_OR_NULL_ORIGIN`). Browsers already send Origin; this is the same SDK with `adminKey` for servers — there is no separate server package.

### Added
- Non-admin list/query/SSE requests default to `limit=100` and are capped at `10000` (`EZBASE_DEFAULT_LIMIT` / `EZBASE_MAX_LIMIT`). Admin-key requests stay unlimited unless `limit` is set.
- Document JSON bodies are capped at 1 MB (`EZBASE_MAX_JSON_BYTES`). Backup restore is unchanged.
- Fresh Postgres clusters initialize as UTF-8 (`C.UTF-8`). Existing volumes are not rewritten.

SDK `@ezwrld/ezbase@1.4.0`.

### Upgrade considerations
- Anonymous `GET /api/collections` no longer returns every table name — only collections whose **read** rule allows the caller. Aura-style `{ "default": "admin" }` instances will return `[]` without the admin key. `listCollections()` with `adminKey` is unchanged.
- `GET /api/databases` returns 401/403 without the admin key. The console already sends it.
- Non-admin clients that listed an entire collection with no `limit` now receive at most 100 docs. Pass `limit` (max 10000) or use the admin key.
- Image downloads still work in `<img src>` in Chromium; navigating to a stored HTML file downloads instead of executing.
- Existing Postgres volumes keep their current encoding. Only new `initdb` runs are UTF-8.

## v1.5 — 2026-08-22

### Added
- Strong `ETag` headers on document reads and conditional PATCH through
  `If-Match`. A stale writer receives `412 Precondition Failed`.

### Upgrade considerations
- None. PATCH remains unconditional when `If-Match` is omitted.

## v1.4 — 2026-08-19

### Fixed
- Realtime SSE streams (collection, document, analytics live feed) survive quiet periods. The server now writes a keep-alive comment every 15 seconds and raises Bun's idle timeout to 60 seconds; previously Bun's default 10-second idle kill severed every stream between events, forcing clients into a permanent reconnect loop.
- Closed SSE connections release their handler state. The keep-alive loop now exits on disconnect and unsubscribes in `finally`; previously every connection ever opened was retained until the process was OOM-killed (observed in production: ~20 KB leaked per connection, 2.6 GB RSS at death under reconnect churn).

### Upgrade considerations
- None. Keep-alive comments are part of the SSE protocol and invisible to all SDK versions.

## SDK v1.3.0 — 2026-08-18

### Fixed
- A realtime response that ends cleanly now calls the subscription error handler instead of silently freezing the listener.

### Upgrade considerations
- None.

## SDK v1.2.0 — 2026-08-18

### Fixed
- Realtime subscriptions now send session and admin credentials only in the authorization header. Tokens no longer appear in SSE URLs or proxy logs.

### Upgrade considerations
- None.

## v1.3 — 2026-08-17

### Added
- Collection and query reads support typed SDK `.select('name', 'status')` and REST `fields=name,status` projection. EzBase projects top-level document data in Postgres before returning it. The document envelope is always included, and reads without selection are unchanged.

### Upgrade considerations
- None.

## v1.2 — 2026-08-16

### Added
- `EZBASE_GIN_EXCLUDE` skips the automatic full-document GIN index for named, comma-separated collections whose write cost outweighs filtered reads.

### Upgrade considerations
- None. The default remains unchanged.

## v1.1 — 2026-08-16

### Fixed
- Request analytics now classify collections correctly when ezbase is mounted below a public base path.
- Health and analytics requests below a public base path are no longer recorded as admin traffic.

### Upgrade considerations
- None.

## v1.0 — 2026-08-06

The 1.0 launch. SDK `@ezwrld/ezbase@1.0.0`.

### Added
- **Backups & restore** — streaming tar.gz backups (JSONL per collection + manifest + auth + storage + rules), granular restore (per database/collection/part), query-filtered restore, conflict modes, `ez backup [dest]` / `ez restore <target> [collections]` CLI with auto pipe detection. See `docs/BACKUPS.md`.
- **Password management** — reset via emailed link (SMTP through `SMTP_*` env; without SMTP, links print to server logs), change-password, admin set-password (`PUT /api/auth/users/:id/password`), optional email verification (`EZBASE_REQUIRE_EMAIL_VERIFICATION`).
- **Analytics** — every API request aggregated into per-minute buckets (internal `_ezbase_metrics` table, 14-day retention). Admin endpoints `/api/analytics/{summary,timeseries,live}` + console **Activity** page with live request feed.
- **Write-scope rule enforcement** — rule filters now govern writes: creates auto-stamp missing filter fields (owner's `userId` set from the session), mismatched values are rejected, PATCH cannot move docs across filter scopes.
- **Bucket read/write splits** — `"avatars": { "read": "public", "write": "authenticated" }`.
- `EZBASE_TRUSTED_ORIGINS` for browser auth from other domains; `/api/health` now reports `version`; `docs/RULES.md` + `docs/OAUTH-PROVIDERS.md`.

### Changed
- **Fresh instances now default to `{ "read": "public", "write": "authenticated" }`** for collections *and* buckets. Existing `rules.json` files are respected unchanged.
- **Auth rate limiting is always on** (3 attempts/10s per IP on sign-in/sign-up/change-password). `EZBASE_RATE_LIMIT=false` disables it for test stacks.
- nginx overwrites `X-Forwarded-For` with the real client address (rate-limit buckets can't be spoofed).
- Large restore uploads no longer hit body-size caps (nginx + runtime limits raised for streaming archives).

### Upgrade considerations
- **Existing instances keep their current behavior** — your existing `rules.json` is respected as-is. If its default allows public writes, the server now logs a boot warning; for instances used purely as admin-key server stores, consider setting `{ "default": "admin" }`.
- If any of your **server code signs in with email/password programmatically** at more than 3 attempts per 10s from one IP, it will hit 429s — authenticate once and reuse the session token, or use the admin key.
- If you run ezbase **behind another proxy** (Cloudflare, Caddy), all auth traffic now shares one rate-limit bucket per upstream proxy IP. Set `EZBASE_RATE_LIMIT=false` if that bites, and file an issue for trusted-proxy support.
- Collections using **filter rules** (owner, claims): user creates that previously wrote mismatched filter-field values (e.g. a `userId` that isn't the caller's) are now rejected with 403. Admin-key writes are unaffected.
- No schema migrations. No SDK breaking changes (new methods only).

## v0.0.11 — 2026-08-06

### Added
- Backups & restore v1 (initial merge — see v1.0 notes above for the full feature).

### Upgrade considerations
- None.

## v0.0.10 and earlier — 2026

Document CRUD + queries, real-time SSE, BetterAuth (email/password, OAuth, roles/claims), rules.json permissions, file storage, multi-database support, admin console, SDK, all-in-one image. Pre-changelog era — see commit history.
