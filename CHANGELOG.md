# Changelog

Patch notes and upgrade considerations for every ezbase release. **Agents: this is the file to read when you detect a version difference** — compare your instance's version (`GET /api/health` → `{ version }`) against the entries below before upgrading.

**The versioning promise:**

- Versions are `major.minor` (image tags `v1.0`, `v1.1`; npm shows `1.0.0`, `1.1.0`).
- **Minor releases never break you.** New features, fixes, and additive API surface only. Upgrading is: pull the new image, restart.
- **Breaking changes only ever land in a new major**, and the entry carries a **⚠ BREAKING** section describing exactly what breaks and how to migrate. If you see a major-version jump, read that section before upgrading.
- Every entry has an **Upgrade considerations** section — "none" means none.

Pin `ghcr.io/ezwrld/ezbase:1.0`-style tags to control when you take upgrades; `:latest` tracks the newest release.

---

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
