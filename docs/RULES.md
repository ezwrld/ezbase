# Rules & Security

Everything about who can read and write what in ezbase. One file — `rules.json` — controls access to every collection and storage bucket in the instance.

If you know Firebase security rules: it's the same idea, but instead of a little programming language you get a **menu written as JSON**. Less expressive, much harder to get wrong, and — unlike Firestore — the rules also *filter your queries for you*.

## The one-minute version

```json
{
  "default": { "read": "public", "write": "authenticated" },
  "collections": {
    "feed":     { "read": "public", "write": "authenticated" },
    "notes":    "owner",
    "invoices": { "access": "authenticated", "filter": { "orgId": "claims.orgId" } },
    "reports":  { "read": "role:superadmin", "write": "admin" }
  },
  "buckets": {
    "avatars": "authenticated",
    "public_assets": "public"
  }
}
```

- `default` — what applies to any collection/bucket not listed. Fresh instances get `{ "read": "public", "write": "authenticated" }`: anyone can read, writes need a signed-in user or the admin key.
- Every rule is either a single level (applies to read *and* write) or `{ "read": ..., "write": ... }`. Write covers create, update, and delete.
- The **admin key bypasses everything** (like the Firebase Admin SDK). Keep it server-side.

## The canonical example: a user dashboard

You auth users, they see a dashboard with *their* API keys. This is the whole setup:

```json
{ "collections": { "api_keys": "owner" } }
```

```typescript
// After ez.auth.signIn(...) — note there is NO uid handling anywhere:

await ez.collection('api_keys').add({ name: 'prod', key: generateKey() })
// → server stamps userId from the verified session token

const myKeys = await ez.collection('api_keys').get()
// → returns ONLY this user's keys — the rule is the WHERE clause

ez.collection('api_keys').onSnapshot((keys) => render(keys))
// → live-updating, same scoping
```

**Best practice for writing the uid: you don't.** The client never sends `userId` — the server derives it from the session token (which it verified) and writes it onto the doc. The client *cannot* set it to someone else's id; that's rejected with 403. Fetching another user's doc by id returns 404. There is no client-side step where you "remember to attach the uid," and therefore no way to forget it.

This is the part that feels different from Firebase: there, your client code writes `uid: auth.currentUser.uid` into the doc and a rule *checks* it — forget either half and you have a bug. In ezbase the rule *does* it.

## Coming from Firebase

**"You can read it if your auth'd uid == the document's uid"**

```
// Firestore
allow read: if request.auth.uid == resource.data.uid;
```
```json
// ezbase
"notes": { "read": { "access": "authenticated", "filter": { "uid": "auth.id" } } }
```

The `filter` is `{ "<field on the document>": "<value from the signed-in user>" }` — the same comparison, written as a key/value pair. If your field is named `userId`, the whole rule shortens to:

```json
"notes": "owner"
```

(`"owner"` is sugar for `{ "access": "authenticated", "filter": { "userId": "auth.id" } }`.)

**"You can read it if your custom attribute .superadmin is set"**

```
// Firestore
allow read: if request.auth.token.superadmin == true;
```
```json
// ezbase
"reports": { "read": "role:superadmin" }
```

with the role set on the user: `admin.auth.setRole(userId, 'superadmin')`. Every user has one `role` string (default `"user"`).

**The role/claims split:**
- **`role` = who you are.** One string per user. Gate collections with `"role:<name>"`. Use it for the boolean-attribute checks you'd do with Firebase custom claims (`superadmin`, `moderator`, ...).
- **`claims` = which docs are yours.** Arbitrary JSON per user, matched against document fields via `filter`. Use it for tenancy.

## Permission levels

| Level | Anonymous | Authenticated | Matching role | Admin key / admin role |
|-------|-----------|---------------|---------------|------------------------|
| `public` | ✓ | ✓ | ✓ | ✓ |
| `authenticated` | 401 | ✓ | ✓ | ✓ |
| `role:<name>` | 401 | 403 | ✓ | ✓ |
| `owner` | 401 | own docs only | own docs only | ✓ |
| `admin` | 401 | 403 | 403 | ✓ |

## Filters

A filter is an equality match between a document field and the signed-in user:

- `"auth.id"` — the user's id
- `"claims.<key>"` — a value from the user's claims (nested paths like `"claims.org.id"` work)
- Claim is an **array** → "field must be one of" (e.g. `orgIds: ["acme", "initech"]`)
- Multiple filter keys → **AND**

### On reads: filters ARE the query

The filter becomes a `WHERE` clause on every read. `ez.collection('notes').get()` returns *your* notes — no need to write the `where` yourself. Fetching a single doc that doesn't match your filter returns **404** (not 403 — existence isn't leaked). This is the opposite of Firestore's "rules are not filters" gotcha, where an unfiltered query just fails.

### On writes: filters are enforced, and creates are auto-filled

- **Create** — if you omit the filtered field, ezbase fills it in with *your* value: in an `owner` collection, `ez.collection('notes').add({ title })` gets `userId` set from your session automatically. If you set it to someone else's value → 403. Users cannot create documents outside their own scope.
- **Update (PATCH)** — changing a filtered field to a value that isn't yours → 403. Documents can't be moved between users or orgs.
- **Replace (PUT) / Delete** — only allowed on docs that already match your filter, and replacement data must stay in scope.
- Array-valued claims can't be auto-filled (ezbase can't guess which org you meant) — the field is required on create and must be one of your permitted values.

## Multi-tenancy recipe

```json
{
  "collections": {
    "invoices": { "access": "authenticated", "filter": { "orgId": "claims.orgId" } }
  }
}
```

```typescript
// Server-side, when a user joins an org:
await admin.auth.mergeClaims(userId, { orgId: 'acme' })

// Client-side — every call is automatically scoped to their org:
await ez.collection('invoices').get()                 // only acme's invoices
await ez.collection('invoices').add({ total: 99 })    // orgId: 'acme' auto-filled
```

Users in multiple orgs: `{ orgIds: ['acme', 'initech'] }` + `"filter": { "orgId": "claims.orgIds" }`.

## Storage buckets

Buckets take a level (`"public"`, `"authenticated"`, `"role:<name>"`, `"admin"`, `"owner"`) or a read/write split:

```json
{
  "buckets": {
    "avatars":   { "read": "public", "write": "authenticated" },
    "documents": "owner",
    "exports":   "admin"
  }
}
```

- `{ "read": ..., "write": ... }` — delete counts as write. A missing side falls back to `default`.
- `"owner"` — any signed-in user can upload; each user can only list/download/delete **their own** files. Like collection ownership, `uploaded_by` is stamped server-side from the session — clients can't claim someone else's files.
- Unlisted buckets fall back to `default` (reads use its read level, writes its write level).
- No filters on buckets yet (org-shared buckets) and no signed/expiring URLs — future work.

## Writing on behalf of a user (server-side)

The admin key bypasses rules, so nothing is auto-stamped — on your server **you** say whose doc it is:

```typescript
// admin = new EzBase({ url, adminKey }) — server-side only
await admin.collection('api_keys').add({ name: 'prod', key, userId: theUserId })
```

Where does `theUserId` come from? Usually the request you're handling — the caller sent their ezbase token, verify it and use the id:

```typescript
const me = await fetch(`${EZBASE_URL}/api/auth/me`, {
  headers: { Authorization: req.headers.authorization },
}).then((r) => (r.ok ? r.json() : null))
if (!me) return unauthorized()
await admin.collection('api_keys').add({ name: 'prod', key, userId: me.id })
```

Alternative — act **as** the user instead of as admin, and stamping/scoping apply exactly like on the client:

```typescript
const asUser = new EzBase({ url: EZBASE_URL })
asUser.auth.restoreSession(tokenFromRequest, user)
await asUser.collection('api_keys').add({ name: 'prod', key })  // userId auto-stamped, rules enforced
```

Rule of thumb: pass the user's token through and let rules do the work; reach for the admin key when you're genuinely acting as the system (cron jobs, migrations, cross-user queries).

## How enforcement works

Every request carries a bearer token → the server resolves the user's id, role, and claims → looks up the collection's rule. The access level is the door; the filter is a `WHERE` clause bolted onto the query (reads) or a field check/auto-fill (writes). Collections starting with `_ezbase_` are internal and never accessible through the API. Rules apply across all databases in the instance — collection names are matched instance-wide.

## Editing rules

1. **Console** — Rules tab, edit, save. Persists to `/data/rules.json`, hot-reloads.
2. **Mounted file** — keep `rules.json` in your repo, mount it read-only into the container; the console shows read-only mode and edits go through git.
3. **API/SDK** — `admin.setRules({...})`, `admin.getRules()` (admin only).

The server hot-reloads the file on change and logs a **warning at boot if your effective default write access is `public`** — anyone on the internet being able to write to unlisted collections is almost never what you want.

## What rules can't do (on purpose)

- No arbitrary expressions — you can't write "readable if `status == 'published'` OR owner". It's equality against the caller's identity, nothing else. If a doc should be public, put it in a public collection.
- No cross-document conditions (Firestore's `get()` in rules).
- One rules namespace per instance — two databases both using a `posts` collection share the `posts` rule.

This covers owner-data, role gates, and org tenancy — which is the overwhelming majority of what real apps express in Firestore rules, with none of the rules-language foot-guns.
