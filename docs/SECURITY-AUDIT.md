# Security Audit

Audit of the ezbase codebase assuming source code is public and an attacker knows the target runs ezbase.

> Historical findings. Current release work should be checked against `CHANGELOG.md`. The deny-by-default hardening removes read-triggered collection creation, restricts named-database creation to admins, and prevents client queries from creating indexes.

## CRITICAL

### 1. No rate limiting — brute force auth wide open
There is zero rate limiting anywhere — not in Hono, not in nginx. An attacker can:
- Brute force passwords on `/api/auth/sign-in/email` at full speed
- Credential stuff using leaked email/password combos
- Enumerate users by trying sign-ups and observing error differences
- DoS the instance by flooding any endpoint

### 2. Admin key timing attack (`middleware.ts:20`)
```js
if (token === getAdminKey()) {
```
JavaScript `===` is not constant-time. An attacker can measure response time differences to deduce the admin key character by character. Combined with no rate limiting, this is practical.

**Fix:** Use `crypto.timingSafeEqual`.

### 3. CORS allows all origins (`index.ts:17`)
```js
app.use('*', cors())
```
Hono's default `cors()` sets `Access-Control-Allow-Origin: *`. Any website can make requests to the API and read responses. If an attacker obtains a token (XSS, leaked in logs, etc.), they can use it from any origin.

### 4. Stored XSS via file storage (`storage.ts:226`)
Downloaded files are served with whatever `Content-Type` the uploader claimed. An attacker can upload `text/html` with `<script>` tags. Visiting the download URL executes JS in the ezbase origin context — can steal admin tokens from localStorage, access console, read any data.

**Fix:** Set `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff` on all file download responses.

---

## HIGH

### 5. Admin key logged to stdout (`config.ts:15`)
```js
console.log(`Generated ADMIN_KEY: ${adminKey}`)
```
When `ADMIN_KEY` isn't set in env, the auto-generated key is printed to container logs. Anyone with access to `docker logs` or a log aggregation service gets full admin access.

### 6. Auth token exposed in URL query params
For SSE connections, the token goes in the URL (`?token=<bearer_token>`). This means the token appears in nginx access logs, proxy/CDN logs, browser history, and leaks via `Referer` headers.

### 7. Unauthenticated database enumeration (`routes.ts:437-444`)
`GET /api/databases` has no auth check. Anyone can see every database name. `GET /api/collections` also returns collection names regardless of their permission levels.

### 8. Unlimited table creation / resource exhaustion
`ensureCollection` auto-creates tables on any request. With default rules (`"default": "public"`), any anonymous `GET /api/collections/<anything>` creates a Postgres table. An attacker can create tens of thousands of tables to exhaust Postgres catalog resources.

**Resolved in v1.9:** fresh instances default to `"admin"`; reads do not create tables; non-admin callers cannot create named database schemas; client queries cannot create indexes. Permitted writes still auto-create collection tables.

### 9. No request body size limits
JSON payloads to POST/PUT/PATCH have no size cap. An attacker can POST massive JSON bodies, consuming all server memory. File uploads have `MAX_FILE_SIZE`, but document endpoints don't.

### 10. Open user registration with no controls
BetterAuth is configured with `emailAndPassword: { enabled: true }` with no way to disable self-registration, require email verification, or restrict signup domains.

### 11. No security headers
Neither nginx nor Hono sets security headers:
- No `X-Content-Type-Options: nosniff` (enables MIME sniffing, compounds stored XSS)
- No `X-Frame-Options` (console can be clickjacked)
- No `Content-Security-Policy`
- No `Strict-Transport-Security`
- No `Content-Disposition` on file downloads

---

## MEDIUM

### 12. SSE connection exhaustion
No limit on concurrent SSE connections. Each holds an HTTP connection open indefinitely. An attacker can open thousands from a single machine, exhausting file descriptors and memory.

### 13. No pagination ceiling on queries
`GET /api/collections/:col` with no `limit` returns every document. No server-enforced max. Allows full collection dumps in one request and expensive full-table scans.

### 14. PUT upsert bypasses owner filter on new documents (`routes.ts:333-342`)
The owner filter on PUT only checks existing documents. If the document doesn't exist, no filter check runs and the upsert proceeds. A user with `owner` write permission can create documents with any `userId` field.

### 15. Collection name leak regardless of permissions
`GET /api/collections` lists all collection table names without checking per-collection permissions. Admin-only collection names are visible to anonymous users.

---

## LOW / INFORMATIONAL

### 16. Hardcoded dev credentials in docker-compose
`docker-compose.yml` has `POSTGRES_PASSWORD: ezbase` and `ADMIN_KEY: "test-admin-key"`.

### 17. ID generation has minor bias (`id.ts:8`)
`CHARS` has 31 characters; `256 % 31 != 0`, so the first 8 chars are slightly overrepresented. Not meaningful for security.

### 18. Postgres role has excessive privileges
The `ezbase` role can CREATE schemas, tables, and indexes with no restrictions. Ideally scoped to only `db_*` schemas.

---

## SDK

### 19. Admin key in client code
The SDK constructor accepts `adminKey` and sends it in every request. If used in browser-side code, the admin key is visible in source/devtools.

### 20. No token refresh
Session tokens last 7 days with no refresh. A stolen token gives access for a full week.

---

## Priority fix order

| # | Fix | Effort |
|---|-----|--------|
| 1 | Rate limiting on auth endpoints (at minimum) | Medium |
| 2 | `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff` on file downloads | Low |
| 3 | Constant-time admin key comparison (`crypto.timingSafeEqual`) | Low |
| 4 | Auth check on `GET /databases`, filter collection list by permissions | Low |
| 5 | Security headers in nginx (CSP, X-Frame-Options, HSTS) | Low |
| 6 | Body size limits on JSON endpoints | Low |
| 7 | Restrict CORS to configured origins | Medium |
| 8 | Stop logging the admin key | Low |
| 9 | Max table creation limit or require explicit collection creation | Medium |
| 10 | Disable/gate self-registration | Medium |
