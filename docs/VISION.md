# EZBase — Product Vision

> **This is the product vision document — a mix of what's built and what's planned.** For what's actually implemented today, see [`docs/skill.md`](skill.md) (the canonical reference) and [`CLAUDE.md`](../CLAUDE.md). Sections below are marked **(built)** or **(future)**.

**Your data comes first. Structure follows when you're ready.**

EZBase is a self-hosted, NoSQL-flavored database platform built for developers who want Firebase-level DX without the vendor lock-in, cost, or compromises. It wraps battle-tested infrastructure (Postgres, Meilisearch) behind a zero-config SDK and web console, runs entirely in Docker, and costs nothing beyond your VPS.

---

## Philosophy

### Schema is descriptive, not prescriptive

SQL databases demand you define your schema before your data can exist. Every new feature means migrations, ALTER TABLE, refactoring old rows — a tax on momentum that muddies your codebase with domain-irrelevant ops work.

EZBase takes the opposite stance: **data is the source of truth. Types are a lens you put on top.** Like TypeScript itself — which didn't rewrite JavaScript to be typed, but layered types onto what was already there — EZBase lets you dump data freely and adopt structure gradually, on your terms.

No migration files. Ever. No `ALTER TABLE`. No ORM. Change your interface, and EZBase evaluates new writes against the new shape. Old data doesn't break — it just shows as non-conforming until you clean it up (or don't).

### Zero config, zero ceremony

Create a project, explicitly choose which collections clients may access, and start writing documents. No table definitions, migrations, or connection-string wrangling. Collections are created implicitly on the first permitted write. The console gives you visibility. The SDK gives you types. The database just works.

### Self-hosted, self-owned

If a cloud provider goes down, your data does not. EZBase runs on your VPS in Docker Compose. You own the box, you own the data, you own the backups. A $20/mo VPS replaces a $200/mo Firebase bill with room to spare.

---

## Architecture (built)

Three containers in a Docker Compose dev stack (one container in production via supervisord):

| Service | Role | Tech | ~RAM |
|---|---|---|---|
| **API** | REST + SSE + auth + rules engine | Hono on Bun | ~100MB |
| **PostgreSQL** | Document storage (JSONB), pub/sub (LISTEN/NOTIFY), auth (BetterAuth) | Postgres 16 | 500MB–1GB |
| **Console** | Web UI for managing everything | React + Vite (Nginx) | ~30MB |

Meilisearch will be added when full-text search is implemented.

**Total footprint: ~800MB–1.5GB on a 4GB VPS.**

### Why Hono?

Hono is a lightweight, TypeScript-native web framework built on Web Standards. It runs on Node, Bun, Deno, and Cloudflare Workers — so the API layer is runtime-portable with zero code changes. The type inference is excellent, which matters for an SDK project where routes need to be tight. SSE is supported natively. It's used in production by Cloudflare internally and a growing list of companies. It's fast, small (~14KB), and the middleware model is cleaner than Express.

If the runtime landscape shifts (Node → Bun, etc.), the Hono code migrates unchanged. That's the kind of future-proofing worth having for infrastructure you depend on.

### Why Postgres?

Postgres is just the storage engine. You never interact with it directly. No SQL, no migrations, no ORM. Under the hood, each collection gets its own table, created automatically on its first permitted write. Reads never create database objects. Postgres LISTEN/NOTIFY powers the realtime layer. You get the reliability of a 30-year-old database with the DX of a document store.

### Table structure (per collection)

When an allowed caller first writes to `db.collection('bookings')`, EZBase automatically creates:

```sql
CREATE TABLE IF NOT EXISTS col_bookings (
  id         TEXT PRIMARY KEY,
  data       JSONB NOT NULL DEFAULT '{}',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bookings_data ON col_bookings USING GIN (data);
CREATE INDEX IF NOT EXISTS idx_bookings_created ON col_bookings (created_at);
```

You never see this SQL. The API handles table creation, GIN indexing, and cache invalidation internally. The `col_` prefix avoids collisions with Postgres system tables and BetterAuth's tables. Configure the collection rule once, then `.collection('whatever')` works without schema setup.

**Why one table per collection (not one mega-table)?** GIN indexes scale with table size. If bookings and analytics events share a table, every query pays the cost of indexing both. Separate tables mean each index is scoped to its collection. Postgres also maintains vacuuming, autovacuum tuning, and table statistics per table — one mega-table means hot collections pollute the maintenance of cold ones.

Additional internal tables:

- `_ezbase_files` — file storage metadata (path, bucket, size, mime type, uploader)
- `user`, `session`, `account`, `verification` — managed by BetterAuth (auth users, sessions)

Permissions are defined in `rules.json` (file on disk, not in Postgres).

### Capacity at scale

| Scenario | Concurrent SSE | RAM | Monthly cost |
|---|---|---|---|
| Small production apps (50–200 users) | ~200–600 | ~500MB | $5–10 |
| Moderate growth (1K–2K users) | ~3K–6K | ~1.5–2GB | $20 |
| Heavy analytics + search | Same | ~2.5–3GB | $20–24 |

A single Bun process can hold 10,000–50,000 concurrent SSE connections. At small-to-medium scale, compute is never the bottleneck.

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

## Gradual Type System (future — not built)

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

## Relations & Resolution (future — not built)

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

## Security Model (built)

### Layers

| Layer | Purpose | Where it lives |
|---|---|---|
| **Auth Token (Session)** | Identifies who is making the request. Issued on login via BetterAuth. | Authorization header |
| **Collection Rules** | Determines what that user can access. Evaluated on every request including SSE. | `rules.json` |
| **Admin Key** | Server-to-server secret. Bypasses all rules. Never touches the client. | Server env vars |

### Auth (built)

Powered by BetterAuth — session-based authentication stored in Postgres. Supports email/password out of the box, OAuth when provider credentials are configured. Auth secret auto-generated and persisted to disk.

### Collection permissions (built)

Per-collection rules defined in `rules.json` with separate read/write levels, claim-based document filters, and role-based access. See `docs/skill.md` for the full rules format.

---

## Full-Text Search (future — not built)

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

## File Storage (built)

**Status:** Built. See `docs/STORAGE.md` for architecture details.

Files are stored on the filesystem (Docker volume at `/data/files/`) with metadata tracked in Postgres (`_ezbase_files` table). Bucket permissions use the existing `rules.json` system.

```typescript
// Upload (auto-generated path)
const meta = await ez.storage('avatars').upload(file)

// Upload to specific path
const meta = await ez.storage('avatars').upload('profile.jpg', file)

// Get URL (no network call)
const url = ez.storage('avatars').file('profile.jpg').url

// Download
const blob = await ez.storage('avatars').file('profile.jpg').download()

// List files
const files = await ez.storage('avatars').list()

// Delete
await ez.storage('avatars').file('profile.jpg').delete()
```

Bucket permissions in `rules.json`:

```json
{
  "buckets": {
    "avatars": "authenticated",
    "documents": "owner",
    "public_assets": "public"
  }
}
```

Backups: `pg_dump` for metadata + `tar` for files, or mount a persistent volume and let your VPS backup strategy handle it.

---

## SDK (built)

One SDK, two modes. Published to npm as `@ezwrld/ezbase`. Written in TypeScript, zero dependencies. Unlike Firebase's split client/admin SDKs, EzBase uses a single SDK with identical syntax everywhere:

```typescript
import { EzBase } from '@ezwrld/ezbase'

// Client mode — rules enforced, auth required for locked collections
const ez = new EzBase({ url: 'http://localhost:7003' })

// Admin mode — same SDK, same API, rules bypassed
const ez = new EzBase({ url: 'http://localhost:7003', adminKey: '...' })
```

See `docs/skill.md` for the full SDK reference.

---

## Backups (future — not built)

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

## Console

### What's built

The console is a React + Vite + Tailwind SPA gated behind admin key login. Dark theme. Communicates with the Hono API using the admin key stored in localStorage.

**Current pages:**
- **Dashboard** — collection stats overview
- **Collections** — sidebar list with doc count badges, click to view live-updating document table
- **Rules** — JSON editor for `rules.json`, shows read-only mode if file is mounted
- **Storage** — file browser with bucket list, file listing, upload

**Sidebar:** Database selector dropdown, collection list, Rules nav, Storage nav. Header has logout button.

### Console vision (future — not built)

The following pages are planned but not yet implemented:
- **Auth page** — user management UI (list users, edit roles/claims, revoke sessions)
- **Search page** — Meilisearch config and search playground
- **Backups page** — backup scheduling and restore UI
- **Settings page** — instance info, API monitoring, system stats
- **Collection schema tab** — type conformance dashboard (requires gradual type system)
- **Inline document editing** — JSON editor with validation

---

*EZBase: stop paying cloud providers to hold your JSON hostage.*
