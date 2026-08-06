# ezbase

Self-hosted document database with Firebase-level DX. One Docker image, one port, zero config.

## Quick Start

```yaml
# docker-compose.yml
services:
  ezbase:
    image: ghcr.io/ezwrld/ezbase:latest
    ports:
      - "7003:7003"
    volumes:
      - ezbase-data:/data

volumes:
  ezbase-data:
```

```bash
npm install @ezwrld/ezbase
```

```typescript
import { EzBase } from '@ezwrld/ezbase'

const ez = new EzBase({ url: 'http://localhost:7003' })

await ez.collection('todos').add({ title: 'Ship it', done: false })

const todos = await ez.collection('todos').get()
```

Console at `http://localhost:7003/console`.

## What You Get

- **Documents** — schemaless JSONB, collections created on first write
- **Real-time** — SSE subscriptions on collections, queries, or individual docs
- **Auth** — email/password, OAuth providers, session tokens, custom roles & claims
- **Permissions** — per-collection rules with separate read/write levels, claim-based document filters
- **File storage** — upload/download/delete, bucket permissions, owner mode
- **Querying** — `where`, `orderBy`, `limit`
- **Multi-database** — isolated databases per instance, shared auth
- **Admin console** — database selector, document tables, rules editor, storage browser
- **Backups** — `ez backup` → one inspectable tar.gz, pipe it anywhere; restore whole instances or single collections
- **TypeScript SDK** — zero dependencies, works everywhere

## Docs

[**docs/skill.md**](docs/skill.md) — Full SDK & integration reference.

## Development

```bash
git clone https://github.com/ezwrld/ezbase.git && cd ezbase
source setup.sh && ez up
```

## Roadmap

- [x] Document CRUD + queries + real-time
- [x] Auth (BetterAuth) + OAuth providers
- [x] Custom roles, claims, user management
- [x] Per-collection permissions with read/write split + claim-based filters
- [x] File storage with bucket permissions
- [x] Multi-database support
- [x] Admin console (database selector, rules editor, storage browser)
- [x] SDK + Docker image + CI/CD
- [x] Backups & restore ([docs/BACKUPS.md](docs/BACKUPS.md))
- [ ] Full-text search (Meilisearch)
- [ ] Backup scheduling, restore points, S3 push

## License

MIT
