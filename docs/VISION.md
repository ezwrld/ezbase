# EZBase

**Your data comes first. Structure follows when you're ready.**

EZBase is a self-hosted, NoSQL-flavored database platform built for developers who want Firebase-level DX without the vendor lock-in, cost, or compromises. It wraps battle-tested infrastructure (Postgres, Meilisearch) behind a zero-config SDK and web console, runs entirely in Docker, and costs nothing beyond your VPS.

---

## Philosophy

### Schema is descriptive, not prescriptive

SQL databases demand you define your schema before your data can exist. Every new feature means migrations, ALTER TABLE, refactoring old rows — a tax on momentum that muddies your codebase with domain-irrelevant ops work.

EZBase takes the opposite stance: **data is the source of truth. Types are a lens you put on top.** Like TypeScript itself — which didn't rewrite JavaScript to be typed, but layered types onto what was already there — EZBase lets you dump data freely and adopt structure gradually, on your terms.

No migration files. Ever. No `ALTER TABLE`. No ORM. Change your interface, and EZBase evaluates new writes against the new shape. Old data doesn't break — it just shows as non-conforming until you clean it up (or don't).

### Zero config, zero ceremony

Create a project. Start writing documents. That's it. No table definitions, no schema setup, no connection string wrangling. Collections are created implicitly on first write. The console gives you visibility. The SDK gives you types. The database just works.

### Self-hosted, self-owned

If a cloud provider goes down, your data does not. EZBase runs on your VPS in Docker Compose. You own the box, you own the data, you own the backups. A $20/mo VPS replaces a $200/mo Firebase bill with room to spare.

---

## Architecture

Four containers in a Docker Compose stack:

| Service | Role | Tech | ~RAM |
|---|---|---|---|
| **API** | REST + SSE + auth + rules engine | Hono on Node | ~100MB |
| **PostgreSQL** | Document storage (JSONB), files, the durable core | Postgres 16 | 500MB–1GB |
| **Meilisearch** | Full-text search | Meilisearch | 200–500MB |
| **Console** | Web UI for managing everything | React + Vite (Nginx) | ~30MB |

**Total footprint: ~1–2GB on a 4GB VPS.**

### Why Hono?

Hono is a lightweight, TypeScript-native web framework built on Web Standards. It runs on Node, Bun, Deno, and Cloudflare Workers — so the API layer is runtime-portable with zero code changes. The type inference is excellent, which matters for an SDK project where routes need to be tight. SSE is supported natively. It's used in production by Cloudflare internally and a growing list of companies. It's fast, small (~14KB), and the middleware model is cleaner than Express.

If the runtime landscape shifts (Node → Bun, etc.), the Hono code migrates unchanged. That's the kind of future-proofing worth having for infrastructure you depend on.

### Why Postgres?

Postgres is just the storage engine. You never interact with it directly. No SQL, no migrations, no ORM. Under the hood, each collection gets its own table, created automatically on first write. Postgres LISTEN/NOTIFY powers the realtime layer. You get the reliability of a 30-year-old database with the DX of a document store.

### Table structure (per collection)

When you first write to `db.collection('bookings')`, EZBase automatically creates:

```sql
CREATE TABLE IF NOT EXISTS col_bookings (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  data        JSONB NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now(),
  archived    BOOLEAN DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_bookings_data ON col_bookings USING GIN (data);
```

You never see this SQL. The API handles table creation, GIN indexing, and cache invalidation internally. The `col_` prefix avoids collisions with Postgres system tables. The developer just calls `.collection('whatever')` and it works.

**Why one table per collection (not one mega-table)?** GIN indexes scale with table size. If bookings and analytics events share a table, every query pays the cost of indexing both. Separate tables mean each index is scoped to its collection. Postgres also maintains vacuuming, autovacuum tuning, and table statistics per table — one mega-table means hot collections pollute the maintenance of cold ones.

Additional internal tables:

- `_ezbase_meta` — per-collection config (type schema, permission level, search settings, relations)
- `_ezbase_users` — auth users, hashed passwords, roles, custom claims
- `_ezbase_files_meta` — file metadata (path, size, mime type, ownership, timestamps)
- `_ezbase_files_data` — file binary content (BYTEA)

### Capacity at scale

| Scenario | Concurrent SSE | RAM | Monthly cost |
|---|---|---|---|
| Small production apps (50–200 users) | ~200–600 | ~500MB | $5–10 |
| Moderate growth (1K–2K users) | ~3K–6K | ~1.5–2GB | $20 |
| Heavy analytics + search | Same | ~2.5–3GB | $20–24 |

A single Node process can hold 10,000–50,000 concurrent SSE connections. At small-to-medium scale, compute is never the bottleneck.

### JSONB query performance (4GB VPS, SSD)

| Documents | Indexed nested query | Full aggregation |
|---|---|---|
| 10K | <5ms | Instant |
| 100K | 10–50ms | <500ms |
| 500K | 50–200ms | 1–2s |
| 1M+ | 200ms–1s | 1–3s |

GIN indexes are created automatically by EZBase on every collection at table creation time.

### Redis: intentionally excluded

Postgres reading a row by primary key from RAM: ~0.1–0.5ms. Redis doing the same: ~0.05–0.1ms. The marginal gain doesn't justify the added complexity and cache invalidation headaches. Postgres has its own buffer cache — if your data fits in RAM (and at this scale it does), hot data lives in memory already. Add Redis later if you ever actually need it.

---

## Gradual Type System

This is EZBase's killer feature — the thing nobody else does well. Firebase has no schema at all. SQL is all schema. PocketBase forces schemas. EZBase offers a spectrum.

### Define types in TypeScript

```typescript
interface Checkout {
  id: string
  userId: string
  bookingIds: string[]
  total: number
  status: 'pending' | 'paid' | 'refunded'
  createdAt: string
}
```

### Register them with EZBase

```typescript
ez.defineCollections({
  checkouts: Checkout,
  bookings: Booking,
})
```

### Three enforcement modes (per collection, toggled in console)

| Mode | Behavior |
|---|---|
| **Off** (default) | Anything goes. Full NoSQL freedom. |
| **Warn** | Non-conforming writes are logged but allowed through. Console shows drift. |
| **Strict** | Non-conforming writes are rejected. Production guardrails. |

### Collection health dashboard (Console)

The auditor — built into the web console — continuously evaluates documents against their declared type:

```
checkouts — 98.2% conformance
  ├─ 847/862 documents fully conform
  ├─ 12 documents missing `status` field
  └─ 3 documents have `total` as string (expected number)
  [Auto-fix] [Generate migration script] [Dismiss]
```

One-click remediation. No migration files. You change your interface, the auditor shows you drift, and you clean up when you're ready — or don't.

---

## Relations & Resolution

NoSQL's biggest shortcoming: no joins. EZBase handles this at the SDK level.

### Declare relations in your config

```typescript
ez.collection<Checkout>('checkouts', {
  resolve: {
    bookingIds: 'bookings',
  },
})
```

### Use them naturally

```typescript
// Raw — just IDs
const checkout = await db.collection('checkouts').doc(id).get()
// checkout.bookingIds = ['abc', 'def']

// Resolved — full objects
const checkout = await db.collection('checkouts').doc(id).get({ resolve: ['bookingIds'] })
// checkout.bookings = [{ id: 'abc', date: '...', ... }, { id: 'def', ... }]
```

Under the hood: a batched `SELECT * FROM bookings WHERE id IN (...)`. No joins, no SQL, no N+1 problems. The SDK handles it.

Realtime resolution also works — subscribe to a checkout AND its resolved bookings, get updates when any of them change. This is better than what Firebase offers out of the box.

---

## Security Model

### Layers

| Layer | Purpose | Where it lives |
|---|---|---|
| **Project Key** | Identifies which project a request is for. Public, non-secret. Ships in client code. | Client SDK config |
| **Auth Token (JWT)** | Identifies who is making the request. Issued on login. | Authorization header |
| **Collection Rules** | Determines what that user can access. Evaluated on every request including SSE. | Console / config |
| **Admin Key** | Server-to-server secret. Bypasses all rules. Never touches the client. | Server env vars |

### Auth

JWT-based. Users table in Postgres with bcrypt-hashed passwords. OAuth provider support via standard provider SDKs. The SDK exposes:

```typescript
// Email/password
await ez.auth.signUp({ email, password })
await ez.auth.signIn({ email, password })

// OAuth
await ez.auth.signInWithProvider('google')

// Current user
const user = ez.auth.currentUser
```

The JWT includes user ID, role, and any custom claims you set. Tokens refresh automatically.

### Collection permissions

Three levels per collection, configured in the console or a config file. Covers 90% of real-world use cases without the complexity of Firebase's expression-based rules:

```json
{
  "public_content": "public",
  "bookings": "authenticated",
  "admin_analytics": "admin"
}
```

| Level | Behavior |
|---|---|
| **public** | Anyone can read, no auth needed |
| **authenticated** | Any logged-in user with a valid JWT can read |
| **admin** | Only admin key can read (server-side only) |

For cases where you need document-level filtering (e.g., users can only read their own bookings), add a `filtered` mode later:

```json
{
  "bookings": { "level": "filtered", "ownerField": "userId" }
}
```

This tells EZBase to match `doc.userId` against `auth.userId` automatically. But don't build this until you need it — collection-level permissions go surprisingly far.

---

## Full-Text Search

Powered by Meilisearch. Enabled per-collection in the console.

### Setup (Console)

1. Toggle search on for a collection
2. Select which fields to index
3. Done — Meilisearch maintains the index automatically

On every write to Postgres, the API pushes the document to Meilisearch asynchronously. The SDK exposes:

```typescript
const results = await db.collection('bookings').search('beach resort cancun', {
  filters: { status: 'confirmed' },
  limit: 20,
})
```

Typo tolerance, ranking, and tokenization are handled by Meilisearch out of the box. ~100–200MB RAM overhead for small datasets.

---

## File Storage

Files are stored directly in Postgres as binary data (`BYTEA`). No extra services, no filesystem volumes to manage, no sync issues. Your data and your files live in the same database, back up together atomically, and restore together.

```typescript
// Upload
const ref = await ez.storage.upload('avatars/user123.jpg', file)

// Get URL
const url = ez.storage.url('avatars/user123.jpg')

// Delete
await ez.storage.delete('avatars/user123.jpg')
```

Under the hood, two internal tables:

- `_ezbase_files_meta` — path, size, mime type, ownership, timestamps
- `_ezbase_files_data` — the actual binary content

For a few GB of images and PDFs, this is a non-issue. A 5GB database dumps in under a minute. If file backups ever grow large enough to be annoying, `pg_dump` can target tables separately — back up file data weekly, everything else daily. Same tool, just a flag.

The "don't store files in Postgres" advice is for people serving terabytes of video. For app images, avatars, and document uploads, keeping everything in one place means one backup, one restore, zero orphaned references, zero extra infrastructure.

---

## SDK

One SDK, two modes. Published to npm as `@ezbase/sdk`. Written in TypeScript. Unlike Firebase's split client/admin SDKs with completely different APIs, EZBase uses a single SDK with identical syntax everywhere. The mode is determined by how you initialize it:

```typescript
import { EZBase } from '@ezbase/sdk'

// Client mode — rules enforced, auth required for locked collections
const ez = new EZBase({
  url: 'https://your-vps.com:3000',
  projectKey: 'pk_live_xxxxxxxx',
})

// Admin mode — same SDK, same API, rules bypassed
const ez = new EZBase({
  url: 'https://your-vps.com:3000',
  adminKey: 'sk_live_xxxxxxxx',
})
```

The only difference is what header gets sent. Project key + JWT, or admin key. Your Hono API checks which one it received and either evaluates rules or skips them. Same `.collection()`, same `.get()`, same `.onSnapshot()`. Developer muscle memory is identical across client and server code. Prototype with admin mode everywhere, swap to client mode when you're ready for users — zero API changes.

### Core API surface

```typescript
// CRUD
await db.collection<T>('name').doc(id).get()
await db.collection<T>('name').where('field', '==', value).get()
await db.collection<T>('name').doc(id).set(data)    // admin only
await db.collection<T>('name').doc(id).update(data) // admin only
await db.collection<T>('name').doc(id).delete()     // admin only

// Realtime (SSE)
db.collection<T>('name').doc(id).onSnapshot((doc) => { ... })
db.collection<T>('name').where('status', '==', 'active').onSnapshot((docs) => { ... })

// Search
db.collection<T>('name').search(query, options)

// Auth
ez.auth.signUp({ email, password })
ez.auth.signIn({ email, password })
ez.auth.signInWithProvider('google')
ez.auth.onAuthStateChanged((user) => { ... })

// Storage
ez.storage.upload(path, file)
ez.storage.url(path)
ez.storage.delete(path)
```

The generic `<T>` gives you full autocomplete and type safety at the call site without the database caring about the shape of the data.

---

## Backups

Automated via cron in the Docker setup:

- `pg_dump` on schedule (daily default, configurable) — covers data AND files in one atomic backup
- Shipped to an S3-compatible destination (Backblaze B2, Cloudflare R2, etc.)
- If file storage grows large, dump file tables on a slower schedule (weekly) and data tables daily — same tool, just a flag
- Console shows last backup time and lets you trigger manual backups
- Point-in-time restore from any backup

---

## Positioning

| | Firebase | Supabase | PocketBase | **EZBase** |
|---|---|---|---|---|
| Data model | NoSQL | SQL-first | SQL-first | **NoSQL DX, Postgres core** |
| Schema | None | Migrations | Forced | **Gradual, optional** |
| Self-hosted | No | Yes (complex) | Yes (single binary) | **Yes (Docker Compose)** |
| Realtime | Yes | Yes | Yes | **Yes (SSE)** |
| Full-text search | No (needs Algolia) | Basic | Basic | **Meilisearch built-in** |
| File storage | Yes (expensive) | Yes | Yes | **Yes (Postgres, disk-priced)** |
| Cost at small scale | $50–200+/mo | $25+/mo | Free | **$10–20/mo VPS** |
| TypeScript DX | Decent | Good (with gen) | Weak | **First-class** |
| API framework | Proprietary | Proprietary | Go | **Hono (portable)** |

---

## Non-goals

- Not a BaaS product for others. Built for personal/small-team use.
- Not trying to handle massive scale. Optimized for <1M documents per collection.
- Not replacing SQL for relational-heavy domains. This is for document-oriented apps.
- Not competing with managed services on ops convenience. You own the box, you own the uptime.

---

## Console Spec

The EZBase Console is a React SPA that serves as the admin interface for managing your entire EZBase instance. It communicates with the Hono API using the admin key.

### Tech stack

- **React 18** + **TypeScript**
- **Vite** for build/dev
- **Tailwind CSS** + **shadcn/ui** for components
- **Nginx** serving the built static assets in Docker
- **React Router** for client-side routing
- Communicates with the Hono API over REST (same admin key auth)

### Container setup

The console is built at Docker image build time (`vite build`), and Nginx serves the static output. The API URL and admin key are injected at build time via environment variables (or at runtime via a small config endpoint the console fetches on load). Nginx also reverse-proxies `/api/*` requests to the Hono container, so the console and API share a single origin — no CORS.

### Layout

Persistent sidebar navigation. Top bar with instance name, connection status indicator (green dot = API reachable), and current database size. Dark mode by default with a light mode toggle.

**Sidebar sections:**

- Collections
- Auth
- Storage
- Search
- Backups
- Settings

### Pages

#### 1. Collections (default landing page)

**Collection list view:**

- Left panel: list of all collections, sorted alphabetically, with document count badge next to each name
- Search/filter bar at the top of the list
- "New Collection" button (though collections are also created implicitly via the SDK)
- Each collection shows: name, document count, permission level tag (`public` / `authenticated` / `admin`), conformance percentage if a type schema is defined

**Collection detail view (clicking a collection):**

Three tabs: **Documents**, **Schema**, **Settings**

**Documents tab:**

- Paginated table of documents. Columns: `id`, `created_at`, `updated_at`, `archived`, and a preview of the first 2-3 top-level keys from `data`
- Column headers are sortable
- Click a row to expand into a full JSON editor (syntax highlighted, collapsible nested objects)
- Inline editing — edit JSON directly, save button validates against schema if one is set in warn/strict mode
- Bulk actions toolbar: archive selected, delete selected, export as JSON
- Filter bar: filter by any JSONB field path with operators (`==`, `!=`, `>`, `<`, `contains`)
- Realtime indicator — small pulsing dot if SSE listeners are active on this collection, with a count of active connections

**Schema tab:**

- JSON Schema editor showing the current type definition (if any) for this collection
- Enforcement mode toggle: Off / Warn / Strict — radio group with descriptions
- Conformance health report:
  - Overall percentage bar (e.g., 98.2%)
  - Breakdown table: each non-conforming issue as a row with field path, expected type, actual type/value, affected document count
  - "View affected documents" link per issue that pre-filters the Documents tab
  - Action buttons per issue: "Auto-fix" (with preview of what changes), "Generate script", "Dismiss"
- Validation log: recent non-conforming write attempts (timestamp, document ID, issue)

**Settings tab:**

- Permission level dropdown: `public` / `authenticated` / `admin` / `filtered`
- If `filtered`: owner field input (e.g., `userId`)
- Search toggle: enable/disable Meilisearch indexing for this collection
- If search enabled: multi-select for which top-level JSONB fields to index
- Relation declarations: list of field → target collection mappings, add/remove
- Danger zone: drop collection (with confirmation modal and type-to-confirm)

#### 2. Auth

**Users list:**

- Paginated table: email, role, created date, last sign-in, status (active/disabled)
- Search by email
- Click to expand: full user detail, custom claims editor (JSON), role dropdown, disable/enable toggle, delete button
- "Create user" button: email, password, role form

**Sessions:**

- Active sessions list: user, token issued at, expires at, IP address
- Revoke individual sessions or revoke all for a user

**Settings:**

- OAuth provider configuration: toggle providers on/off, input client ID / secret per provider
- JWT settings: token expiry duration, refresh token behavior
- Password policy: minimum length, require special characters (toggles)

#### 3. Storage

**File browser:**

- Tree/list view of all stored files organized by path prefix
- Columns: filename, path, size, mime type, uploaded at, owner (user ID or "system")
- Upload button: drag-and-drop zone or file picker, with path prefix input
- Click a file: preview panel (renders images inline, shows PDF icon for PDFs, raw info for other types)
- File actions: download, copy URL, delete
- Bulk delete
- Storage usage summary at the top: total size, file count, breakdown by mime type (small pie/donut chart)

#### 4. Search

**Per-collection search config:**

- List of all collections with search enabled/disabled toggle
- For enabled collections: which fields are indexed, index size, last sync time
- "Re-index" button per collection (triggers full re-sync from Postgres to Meilisearch)

**Search playground:**

- Dropdown to select collection
- Search input with live results
- Shows ranked results with highlighted matching fields
- Useful for testing search config and relevance tuning

#### 5. Backups

**Backup list:**

- Table of all backups: timestamp, size, type (scheduled/manual), destination, status (success/failed)
- "Backup now" button (triggers immediate `pg_dump`)
- Per-backup actions: download, restore (with confirmation modal)

**Backup settings:**

- Schedule: cron expression input with human-readable preview (e.g., "Every day at 3:00 AM")
- Destination config: S3-compatible endpoint URL, bucket name, access key, secret key — test connection button
- Retention policy: keep last N backups, or keep backups for N days
- Separate schedule toggle for file data table (e.g., weekly vs daily for document data)

#### 6. Settings

**Instance info:**

- Instance name (editable)
- API URL (read-only, shown for copying into SDK config)
- Project key (read-only, copyable)
- Admin key: masked by default, reveal button, regenerate button (with warning modal)
- Database stats: total size, per-collection breakdown, number of active SSE connections

**API monitoring:**

- Request count over time (line chart, last 24h / 7d / 30d toggle)
- Breakdown by endpoint / collection
- Average response time
- Active SSE connections over time
- Error rate

**Docker / system:**

- Postgres version, uptime
- Meilisearch version, index sizes
- Disk usage, RAM usage (from Docker stats)
- Container health status indicators

---

*EZBase: stop paying cloud providers to hold your JSON hostage.*
