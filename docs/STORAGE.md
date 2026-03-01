# File Storage

**Status:** Built. Files on disk, metadata in Postgres.

Files live on the filesystem (Docker volume at `STORAGE_PATH`, default `/data/files/`), not in Postgres. Metadata lives in Postgres (`_ezbase_files` table in `public` schema). This avoids bloating the database, keeps `pg_dump` fast for document backups, and means Bun's native `sendfile()` handles streaming.

---

## Architecture

```
ezbase container
├── nginx (:7003)
│   ├── /api/*          → node server (proxy)
│   ├── /console/*      → static files
│   └── /api/files/*    → node server (upload/delete go through API for metadata bookkeeping)
├── node server (:8080)
│   ├── document routes (existing)
│   └── storage routes  (new)
├── postgres
│   ├── document tables (existing)
│   └── _ezbase_files   (metadata only — no binary data)
└── /data/files/         (Docker volume — actual file bytes)
```

Files are written to `/data/files/` inside the container, backed by a named Docker volume. This is the same containment model as Postgres data — it's all "inside ezbase." When the volume is removed (`ez down --nuke`), files go with it. When the volume is backed up, files are included.

---

## Storage layout on disk

```
/data/files/
├── avatars/
│   ├── abc123.jpg
│   └── def456.png
├── documents/
│   └── receipt_2024.pdf
└── uploads/
    └── video.mp4
```

Path structure mirrors what the user provides. The "bucket" is just the first path segment (like `avatars/`). No UUIDs or hashing for v1 — paths are human-readable and match what the SDK specifies.

---

## Metadata table

```sql
CREATE TABLE IF NOT EXISTS _ezbase_files (
  path       TEXT PRIMARY KEY,           -- e.g. 'avatars/user123.jpg'
  bucket     TEXT NOT NULL,              -- first path segment, e.g. 'avatars'
  filename   TEXT NOT NULL,              -- e.g. 'user123.jpg'
  size       BIGINT NOT NULL,            -- bytes
  mime_type  TEXT NOT NULL,              -- e.g. 'image/jpeg'
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_files_bucket ON _ezbase_files (bucket);
```

This table is small and fast. Queries like "list all files in avatars/" or "total storage used" are just metadata lookups. The actual bytes never touch Postgres.

---

## API endpoints (all under `/api`)

| Method | Path | Description |
|--------|------|-------------|
| `POST`   | `/storage/:bucket` | Upload file (multipart/form-data). Optional `path` field to specify subdirectory. |
| `GET`    | `/storage/:bucket` | List files in bucket (returns metadata array) |
| `GET`    | `/storage/:bucket/*path` | Download file (streams from disk) |
| `DELETE` | `/storage/:bucket/*path` | Delete file (removes from disk + metadata) |
| `HEAD`   | `/storage/:bucket/*path` | File info (size, mime type) without downloading |

### Upload flow

1. Client sends `POST /api/storage/avatars` with multipart form data
2. Server streams the file to `/data/files/avatars/<generated-id>.<ext>` (or user-specified path)
3. Server inserts metadata row into `_ezbase_files`
4. Server returns `{ path, url, size, mimeType, createdAt }`

### Download flow

1. Client hits `GET /api/storage/avatars/user123.jpg`
2. Server looks up metadata (for mime type, existence check)
3. Server streams file from disk with correct `Content-Type` and `Content-Length` headers
4. Supports `Range` headers for video seeking

### Delete flow

1. Client hits `DELETE /api/storage/avatars/user123.jpg`
2. Server deletes file from disk
3. Server deletes metadata row
4. Returns 204

---

## SDK surface

Storage is a sibling to documents, just like in Firebase:

```typescript
const ez = new EzBase({ url: 'http://localhost:7003' })

// Upload a file (auto-generated path)
const meta = await ez.storage('avatars').upload(file)
// → { path: 'avatars/m5x8k2j_photo.png', url: '/api/storage/avatars/m5x8k2j_photo.png', ... }

// Upload to specific path
const meta = await ez.storage('avatars').upload('user123.jpg', file)
// → { path: 'avatars/user123.jpg', url: '/api/storage/avatars/user123.jpg', size: 48210, mimeType: 'image/jpeg', ... }

// Upload with nested path
const meta = await ez.storage('receipts').upload('2024/march/invoice.pdf', pdfFile)

// Get download URL (no network call)
const url = ez.storage('avatars').file('user123.jpg').url
// → 'http://localhost:7003/api/storage/avatars/user123.jpg'

// Download file contents
const blob = await ez.storage('avatars').file('user123.jpg').download()

// Delete
await ez.storage('avatars').file('user123.jpg').delete()

// List files in a bucket
const files = await ez.storage('avatars').list()
// → [{ path, bucket, filename, size, mimeType, uploadedBy, created, updated, url }, ...]
```

### SDK implementation

`StorageBucket` class returned by `ez.storage('bucketName')`:

```typescript
class StorageBucket {
  async upload(file: File | Blob): Promise<FileMeta>                    // auto-generated path
  async upload(path: string, file: File | Blob): Promise<FileMeta>     // specific path
  async list(): Promise<FileMeta[]>
  file(path: string): FileHandle
}

class FileHandle {
  get url(): string               // computed, no network call
  async download(): Promise<Blob>
  async delete(): Promise<void>
}

interface FileMeta {
  path: string           // 'avatars/user123.jpg'
  bucket: string         // 'avatars'
  filename: string       // 'user123.jpg'
  size: number           // bytes
  mimeType: string       // 'image/jpeg'
  uploadedBy: string | null  // user ID or null (admin uploads)
  created: number        // Unix timestamp (ms)
  updated: number        // Unix timestamp (ms)
  url: string            // '/api/storage/avatars/user123.jpg'
}
```

---

## Backups

Document backups and file backups are **separate**, like Firebase (Firestore vs Storage):

- **Documents:** `pg_dump` — fast, atomic, contains all document data and file metadata
- **Files:** tar/copy of `/data/files/` volume — can be done on a different schedule

The metadata table is always included in `pg_dump`, so you always know what files _should_ exist even if the file backup is slightly behind. This is a feature, not a bug — metadata is the source of truth, and a reconciliation step can flag orphaned or missing files.

### Backup strategy

| What | How | Default schedule |
|------|-----|-----------------|
| Documents + file metadata | `pg_dump` | Daily |
| File bytes | Volume snapshot or tar of `/data/files/` | Weekly (configurable) |

Both can be shipped to S3-compatible storage (Backblaze B2, Cloudflare R2, etc.).

---

## Console — Storage page

File browser in the admin console:

- **Bucket list** in left panel (derived from distinct `bucket` values in metadata table)
- **File grid/list** when you click a bucket — shows thumbnails for images, icons for other types
- **Upload** via drag-and-drop zone or file picker
- **Preview panel** on click — renders images/video inline, shows metadata for other types
- **Actions:** download, copy URL, delete
- **Storage stats** at top: total size, file count, breakdown by bucket

---

## Docker setup

### Volume

```yaml
# docker-compose.yml
volumes:
  postgres-data:
  file-storage:

services:
  server:
    volumes:
      - file-storage:/data/files
```

### Single-image build (future)

When ezbase becomes a single Docker image with supervisord, `/data/files/` is just a directory inside the container. The user mounts one volume at `/data` that contains everything — postgres data dir, file storage, configs. One volume = one ezbase instance.

```bash
docker run -p 7003:7003 -v ezbase-data:/data ghcr.io/ezwrld/ezbase
```

---

## Size limits & validation

For v1, keep it simple:

- **Max file size:** 100MB (configurable via env var `EZBASE_MAX_FILE_SIZE`)
- **Allowed mime types:** All (no restrictions by default, can be locked down per-bucket later)
- **Path validation:** alphanumeric, hyphens, underscores, dots, forward slashes. No `..`, no leading `/`.
- **Duplicate paths:** Overwrites existing file (upsert behavior, same as document `.set()`)

---

## Implementation notes

Deviations from the original plan above:

- **Timestamps** use BIGINT (ms since epoch), consistent with document tables — not TIMESTAMPTZ as originally proposed
- **`uploaded_by`** column added to `_ezbase_files` for owner-based access control
- **Bucket permissions** implemented via `rules.json` `buckets` section — same access levels as collections (`public`, `authenticated`, `admin`, `owner`, `role:*`)
- **`owner` on a bucket** means only the uploader can read/delete their files
- **No claim-based filters** for buckets in v1 — keeps it simple (strings only, no filter objects)
- **`FileMeta` timestamps** are `created`/`updated` (not `createdAt`/`updatedAt`) to match document shape

## What this plan does NOT cover (future)

- **Image transforms** (resize, thumbnail generation) — could add later with sharp
- **CDN / caching headers** — nginx can add cache-control headers, but not in v1
- **Presigned URLs** — not needed for self-hosted
- **Multipart upload for huge files** — not needed at ezbase's target scale
- **Real-time file events via SSE** — could publish to existing pub/sub, but low priority

---

## Implementation order

1. **Metadata table** — add `_ezbase_files` creation to `db.ts` schema init
2. **Storage routes** — new file in `server/src/storage.ts`, mount at `/api/storage` in `index.ts`
3. **File read/write helpers** — stream-based, handle directory creation, path sanitization
4. **SDK `StorageBucket` + `FileHandle`** — new classes in `sdk/src/storage.ts`, export from index
5. **Docker volume** — add `file-storage` volume to `docker-compose.yml`
6. **Console storage page** — file browser UI (depends on console rebuild to React)
7. **Backup tooling** — add file backup script alongside existing pg_dump
