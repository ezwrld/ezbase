# Backups & Restoration

Status: **Partial Implementation**

## Current V1

Implemented now:

- Full-instance backup via container CLI: `ezbasectl backup`
- Full-instance restore via container CLI: `ezbasectl restore`
- Backup archive contains:
  - `manifest.json`
  - `database.sql` (`pg_dump` plain SQL, full database)
  - `files/` from `/data/files` when present
  - `rules.json` when present

Example usage:

```bash
# create a backup file from a running ezbase container
docker exec r2r-ezbase ezbasectl backup > ezbase-backup.tar.gz

# restore from a backup file
cat ezbase-backup.tar.gz | docker exec -i r2r-ezbase ezbasectl restore -
```

Current limitations:

- Full restore only. No selective database/collection restore yet.
- CLI only. No API or console UI yet.
- Uses SQL dump format today, not the JSONL archive format proposed below.
- If `rules.json` is mounted read-only, restore skips overwriting it and logs a warning.

## Problem

No backup/restore capability today. In production as an analytics event store with growing volume. Firebase's restore-everything-or-nothing approach is painful — need granular restoration down to individual collections.

## Goals

- **Single-file backups** — one `.tar.gz` that contains everything needed to restore an instance
- **Granular restoration** — restore everything, a single database, a single collection, auth only, storage only
- **Auto-backups** — configurable schedules, per-collection if needed
- **Inspectable** — backup contents should be human-readable (JSONL, not pg_dump binary)
- **Stats & metadata** — each backup includes manifest with doc counts, sizes per collection, timestamps
- **Agent-friendly** — structured manifest that tooling can analyze (e.g., flag a collection that 100x'd overnight)

## Backup File Format

```
backup-2026-03-05T120000Z.tar.gz
├── manifest.json            # version, timestamp, instance info, stats
├── rules.json               # permission rules
├── databases/
│   ├── default/
│   │   ├── feed.jsonl       # one JSON doc per line
│   │   └── profiles.jsonl
│   └── analytics/
│       └── events.jsonl
├── auth/
│   ├── users.jsonl
│   └── accounts.jsonl
├── storage/
│   ├── avatars/
│   │   └── ...files...
│   └── documents/
│       └── ...files...
└── storage-meta.jsonl       # file metadata from _ezbase_files
```

### manifest.json

```json
{
  "version": 1,
  "createdAt": "2026-03-05T12:00:00Z",
  "ezbaseVersion": "1.2.3",
  "stats": {
    "databases": {
      "default": {
        "collections": {
          "feed": { "docCount": 42, "sizeBytes": 18200 },
          "profiles": { "docCount": 8, "sizeBytes": 3100 }
        }
      },
      "analytics": {
        "collections": {
          "events": { "docCount": 300, "sizeBytes": 95000 }
        }
      }
    },
    "auth": { "userCount": 5 },
    "storage": { "fileCount": 12, "totalSizeBytes": 4500000 },
    "totalSizeBytes": 4616300
  },
  "includes": {
    "documents": true,
    "auth": true,
    "storage": true,
    "rules": true
  }
}
```

Stats make it easy for monitoring/agents to diff between backups and flag anomalies.

### Why JSONL over pg_dump

- Human-readable, grep-able
- Portable — not tied to a specific Postgres version
- Supports granular restore without parsing a monolithic dump
- Each line: `{ "id": "...", "data": {...}, "created_at": ..., "updated_at": ... }`

### Compression

`.tar.gz` — universal, good enough. Could revisit `.tar.zst` later for speed if backups get large.

## Backup Types

| Type | What's included | Use case |
|------|----------------|----------|
| **Full** | Everything: docs, auth, storage, rules | Default, disaster recovery |
| **Documents only** | All databases + collections | Lightweight, most common |
| **Single database** | One database's collections | Targeted backup |
| **Single collection** | One collection from one database | High-frequency backup for hot collections |
| **Auth only** | User/account/session tables | Before auth migrations |
| **Storage only** | Files + metadata | Media backup |

## Auto-Backups

### Configuration

Env vars or `rules.json` extension (TBD):

```
BACKUP_ENABLED=true
BACKUP_SCHEDULE=daily          # daily | weekly | cron expression
BACKUP_RETENTION=7             # keep last N backups
BACKUP_PATH=/data/backups      # default: {STORAGE_PATH}/backups/
BACKUP_TYPE=full               # full | documents | auth | storage
```

### Per-Collection Schedules (stretch goal)

For hot collections like analytics events, support independent schedules:

```json
{
  "backups": {
    "default": { "schedule": "daily", "retention": 7 },
    "collections": {
      "analytics/events": { "schedule": "0 */6 * * *", "retention": 28 }
    }
  }
}
```

This lets you back up a fast-growing analytics collection every 6 hours while everything else runs daily.

## Restoration

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/backups` | Create backup (params: type, database, collection) |
| GET | `/api/backups` | List available backups |
| GET | `/api/backups/:name` | Download backup file |
| DELETE | `/api/backups/:name` | Delete backup |
| POST | `/api/backups/:name/restore` | Restore from backup |
| POST | `/api/restore` | Restore from uploaded file |

### Restore Options

```json
{
  "mode": "full | selective",
  "targets": {
    "databases": ["analytics"],
    "collections": ["analytics/events"],
    "auth": false,
    "storage": false,
    "rules": false
  },
  "conflict": "replace | skip | error"
}
```

- **replace** — overwrite existing docs with backup versions
- **skip** — keep existing, only restore missing docs
- **error** — abort if any conflicts

### Console UI

- **Backups page** — list backups with size, date, type, stats summary
- **Manual backup button** — pick type, trigger, download
- **Restore flow**:
  1. Upload or select a backup
  2. Shows manifest: what's inside, doc counts, sizes
  3. Tree picker: checkboxes for databases/collections/auth/storage
  4. Conflict strategy selector
  5. Confirm + restore
  6. Progress indicator + result summary

## Decisions & Recommendations

### Conflict strategy: default to `replace`

Three options: `replace`, `skip`, `error`. Recommendation: **default to `replace`** — when you're restoring, you almost always want the backup version to win. `skip` is useful for merging (e.g., restoring a collection into a db that has new docs since the backup), `error` is a safety net for cautious restores. But `replace` is the sane default — it's what you'd expect "restore" to mean.

### Auto-restore-point before every restore

Before any restore operation, ezbase should automatically snapshot the current state of whatever's about to be overwritten. So if you restore `analytics/events`, it first backs up the current `analytics/events` to a timestamped restore point. This eliminates the Firebase nightmare of "I restored and now I lost what I had." Restore points can use a shorter retention (e.g., keep last 3) and live in a `restore-points/` subdirectory.

### Remote storage: local disk first, S3 later

Local disk (`{STORAGE_PATH}/backups/`) is fine for v1. Most VPS setups can just rsync or cron-copy backups offsite. S3-compatible storage (works with Backblaze B2, MinIO, etc.) is a good v2 feature but adds config complexity and a dependency. Not worth blocking the initial build.

### Manifest diffing

The manifest stats (doc counts, sizes per collection) unlock a simple but powerful capability: diff two backups to detect anomalies. Could be a CLI command (`ez backup diff backup-a backup-b`) or an API endpoint. Useful for monitoring — "events grew 100x overnight" — without needing a separate observability stack. Low effort to build since manifests are just JSON.

### Streaming for large instances

For the analytics use case (and future growth), backup creation should stream JSONL rows from Postgres rather than loading everything into memory. Same for restore — stream lines into INSERT batches. This is a build-time decision, not a feature toggle. Just do it right from the start.

## Build Order

| Phase | What | Why |
|-------|------|-----|
| **1** | Manual backup + restore via API (full + single-collection) | Gets off zero. Highest value. |
| **2** | Console UI — backup list, manual trigger, restore with tree picker | Makes it usable without curl. |
| **3** | Auto-backup scheduling (env var config) | Set and forget. |
| **4** | Auto-restore-points before restore | Safety net. |
| **5** | Per-collection schedules | For hot collections. |
| **6** | Manifest diffing (API + CLI) | Anomaly detection. |
| **7** | Remote storage (S3-compatible) | Offsite backups. |

Phase 1 is the priority — everything else is incremental on top of a working backup/restore core.

## Open Questions

- How to handle schema drift — restoring a backup from an older ezbase version?
- Should the SDK expose backup/restore methods for programmatic use?
- Max backup size limits / disk space checks before creating a backup?
