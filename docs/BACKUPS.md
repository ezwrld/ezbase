# Backups & Restoration

Status: **Phase 1 built** — manual backup + restore via API and CLI, with granular targets, query-filtered restore, and conflict modes. Scheduling, console UI, restore points, and S3 are future phases.

## Problem

In production as an analytics event store with growing volume. Firebase's restore-everything-or-nothing approach is painful — need granular restoration down to individual collections, and backups that don't live on the same box as the data.

## Goals

- **Single-file backups** — one `.tar.gz` that contains everything needed to restore an instance
- **Granular restoration** — restore everything, a single database, a single collection, auth only, storage only — or only *documents matching a query*
- **Pipeable** — backups stream to stdout/HTTP so getting them **off the box** is one shell pipe; no cloud service needed
- **Inspectable** — backup contents are human-readable (JSONL, not pg_dump binary); `tar -tzf` / `tar -xzOf` work on any machine
- **Stats & metadata** — each backup includes a manifest with doc counts and sizes per collection
- **Agent-friendly** — structured manifest that tooling can analyze (e.g., flag a collection that 100x'd overnight)
- **Streaming** — constant memory regardless of database size (1M+ docs verified); rows stream from Postgres cursors, restores stream line-by-line into batched inserts

## What's built (Phase 1)

- `POST/GET/DELETE /api/backups` + `/api/backups/:name` + `latest` alias
- `POST /api/backups/:name/restore` and `POST /api/restore` (upload an archive)
- Backup types: full / documents / auth / storage; scoping to a database or collection
- Restore targeting: databases, collections, auth, storage, rules — independently selectable
- **Query-filtered restore**: `where` triples + time bounds, so you can roll back one collection by one day
- Conflict modes: `replace` (default) / `skip` / `error` — per-collection transactions, `error` aborts with rollback and a 409
- `ez backup [dest]` / `ez restore <file|name|latest>` CLI — deliberately minimal; the granular/filtered options are API-only for now
- Backups stored in `BACKUP_PATH` (default `{STORAGE_PATH}/.backups` — on the data volume, dot-prefixed so it can never collide with a storage bucket)

## Off-site backups — no cloud required

Backups next to the data aren't backups. The CLI streams archives so off-site is a pipe:

```bash
# From your laptop: pull a backup off the VPS
ssh vps "EZBASE_ADMIN_KEY=... /path/to/ez backup" > backup.tar.gz

# Or skip ssh entirely — the API is already exposed
curl -H "Authorization: Bearer $ADMIN_KEY" https://your-vps/api/backups/latest -o backup.tar.gz

# On the VPS: push to any S3-compatible bucket
ez backup | aws s3 cp - s3://my-bucket/ezbase/backup-$(date +%F).tar.gz

# Cron it (built-in scheduling is a future phase)
0 3 * * * EZBASE_ADMIN_KEY=... /path/to/ez backup --rm | aws s3 cp - s3://my-bucket/ezbase/nightly.tar.gz
```

## CLI

Deliberately minimal — take a backup, restore a backup. Everything granular lives in the API.

```
ez backup [dest]                Back up everything
                                  ez backup              → ./backup-<timestamp>.tar.gz
                                  ez backup ~/backups/   → into that folder
                                  ez backup out.tar.gz   → to that file
                                  ez backup | ssh ...    → piped output streams automatically
ez backup list                  List server-side backups (JSON, includes manifests)
ez backup rm <name>             Delete a server-side backup

ez restore <file|name|latest> [collections]   Restore from a backup (backup wins on conflict)
                                  ez restore backup.tar.gz             → everything
                                  ez restore users,games               → just those collections, from latest
                                  ez restore backup.tar.gz mydb/users  → collection in a named database
```

Connection: `EZBASE_URL` (default `http://localhost:7003` — the instance on this machine) and `EZBASE_ADMIN_KEY` (dev fallback: read from `docker-compose.yml`).

The killer combo — something went wrong today, roll one collection back a day without touching anything else (API; CLI flags for this can come later if wanted):

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_KEY" \
  -d '{"collections":["default/teams"],"before":1784800000000}' \
  http://localhost:7003/api/backups/latest/restore
```

## Backup File Format

```
backup-20260305T120000000Z.tar.gz
├── manifest.json            # version, timestamp, type, scope, stats — always the first entry
├── rules.json               # permission rules (full backups only)
├── databases/
│   ├── default/
│   │   ├── feed.jsonl       # one JSON doc per line
│   │   └── profiles.jsonl
│   └── analytics/
│       └── events.jsonl
├── auth/
│   ├── users.jsonl          # public."user" rows
│   └── accounts.jsonl       # public.account rows (password hashes live here)
├── storage-meta.jsonl       # file metadata from _ezbase_files
└── storage/
    ├── avatars/...files...
    └── documents/...files...
```

Each document line: `{ "id": "...", "data": {...}, "created_at": 1234, "updated_at": 1234 }`

### manifest.json

```json
{
  "version": 1,
  "createdAt": "2026-03-05T12:00:00Z",
  "type": "full",
  "scope": { "database": "analytics" },
  "includes": { "documents": true, "auth": false, "storage": false, "rules": false },
  "stats": {
    "databases": {
      "analytics": { "collections": { "events": { "docCount": 300, "sizeBytes": 95000 } } }
    },
    "auth": { "userCount": 5 },
    "storage": { "fileCount": 12, "totalSizeBytes": 4500000 }
  }
}
```

Stats make it easy for monitoring/agents to diff between backups and flag anomalies.

### Why JSONL over pg_dump

- Human-readable, grep-able, `tar -xzOf backup.tar.gz databases/default/feed.jsonl | head`
- Portable — not tied to a specific Postgres version
- Supports granular + filtered restore without parsing a monolithic dump
- Streams both directions — constant memory at any size

### Why not one giant JSON file

A tar.gz of per-collection JSONL is still *one file* to move around, but a single JSON object must be parsed whole (bad at 1M+ rows), can't be partially restored without full parsing, and isn't grep-able. JSONL preserves the "one file = your database" simplicity while staying streamable.

## Backup Types

| Type | What's included | Use case |
|------|----------------|----------|
| **Full** | Everything: docs, auth, storage, rules | Default, disaster recovery |
| **Documents only** | All databases + collections | Lightweight, most common |
| **Single database** | One database's collections | Targeted backup |
| **Single collection** | One collection from one database | High-frequency backup for hot collections |
| **Auth only** | user/account tables | Before auth migrations |
| **Storage only** | Files + metadata | Media backup |

Scoping to a database/collection implies documents-only (no auth/storage/rules in scoped archives).

## API

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/backups` | Create backup — body `{ type?, database?, collection? }` → `{ name, size, manifest }` |
| GET | `/api/backups` | List backups with manifests |
| GET | `/api/backups/:name` | Download archive (`latest` resolves newest; `X-Backup-Name` header carries the real name) |
| DELETE | `/api/backups/:name` | Delete backup |
| POST | `/api/backups/:name/restore` | Restore from a server-side backup — body is RestoreOptions |
| POST | `/api/restore` | Restore from an uploaded archive (raw tar.gz body, options in `?options=<json>`) |

All admin-only.

### RestoreOptions

```json
{
  "databases": ["analytics"],
  "collections": ["analytics/events", "bare_means_default_db"],
  "documents": true, "auth": false, "storage": false, "rules": false,
  "conflict": "replace",
  "where": [["orgId", "==", "acme"], ["n", ">=", 5]],
  "before": 1784800000000, "after": "2026-06-01T00:00:00Z",
  "timeField": "updated"
}
```

- Empty options `{}` = restore **everything** in the archive.
- Naming any target switches to selective mode: only what you name is restored.
- `where` uses the same `[field, op, value]` triples as the query API, evaluated per document; `created`/`updated` map to the timestamps.
- `before`/`after` accept ms epoch or ISO strings and bound `timeField`.
- Response is a summary: per-collection `{ restored, skipped, filtered }`, auth/storage counts, `rules`, and `warnings`.

### Conflict strategy: default `replace`

When you're restoring, you almost always want the backup version to win. `skip` merges (only restores missing docs), `error` is the safety net — each collection restores in a transaction, so a conflict rolls that collection back and the API returns 409.

## Future phases

| Phase | What | Why |
|-------|------|-----|
| **2** | Console UI — backup list, manual trigger, restore with tree picker + manifest preview | Makes it usable without curl. |
| **3** | Auto-backup scheduling (`BACKUP_SCHEDULE`, `BACKUP_RETENTION` env vars) | Set and forget. |
| **4** | Auto-restore-points before every restore | Snapshot what's about to be overwritten first — eliminates "I restored and lost what I had." Keep last N in `restore-points/`. |
| **5** | Per-collection schedules (`"analytics/events": { "schedule": "0 */6 * * *" }`) | Back up hot collections every 6h, everything else daily. |
| **6** | Manifest diffing (`ez backup diff a b`) | Anomaly detection — "events grew 100x overnight" — without an observability stack. |
| **7** | Built-in S3-compatible push (Backblaze, MinIO, R2) | First-class off-site; the pipe idiom covers it until then. |

## Known Limitations (v1 — accepted)

- **No cross-collection snapshot isolation.** Each collection streams from its own cursor, so a backup taken during heavy writes captures collection A at t0 and collection B at t1. Each individual collection is internally consistent. If you need a frozen-in-time backup, take it during a quiet period.
- **Restore is atomic per collection, not per archive.** Each collection restores in its own transaction; if a restore fails midway (e.g. `conflict: "error"`), earlier collections stay restored. The 409 response says what failed.
- **Backups live on the data volume** (`{STORAGE_PATH}/.backups`). `ez down --nuke` or a dead disk takes them with it — that's why the CLI pipes. Get backups off the box.
- **No version-compat check on restore yet.** The manifest carries `version: 1`; the restore path currently ignores it.
- **Restoring auth does not touch sessions.** Users/accounts (incl. password hashes) roundtrip; active sessions are never backed up.

## Open Questions

- Schema drift — restoring a backup from an older ezbase version (manifest `version` field is the hook)
- Should the SDK expose backup/restore methods for programmatic use?
- Disk space checks before creating a backup?
