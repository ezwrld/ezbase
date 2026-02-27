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
- **Auth** — email/password, session tokens, per-collection permissions
- **Querying** — `where`, `orderBy`, `limit`
- **Admin console** — browse collections and documents
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
- [x] Auth (BetterAuth)
- [x] Admin console
- [x] SDK + Docker image
- [ ] File storage
- [ ] Full-text search (Meilisearch)
- [ ] OAuth providers
- [ ] Gradual type system
- [ ] Backups

## License

MIT
