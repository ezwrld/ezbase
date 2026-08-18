# ezbase

Self-hosted backend in a single Docker container: a NoSQL document store on Postgres, plus auth, per-collection access rules, file storage, realtime subscriptions, backups, request analytics, and an admin console. TypeScript SDK and a plain REST API.

ezbase is a collection of open-source tools wired together behind one API rather than a new database engine: Postgres (JSONB + GIN indexes) handles storage and querying, [BetterAuth](https://better-auth.com) handles sessions, password hashing, and OAuth, nginx fronts the stack. One image, one port (7003), one volume (`/data`).

## Quick Start

```yaml
# docker-compose.yml
services:
  ezbase:
    image: ghcr.io/ezwrld/ezbase:1.0
    ports:
      - "7003:7003"
    volumes:
      - ezbase-data:/data

volumes:
  ezbase-data:
```

```bash
docker compose up -d
npm install @ezwrld/ezbase
```

```typescript
import { EzBase } from '@ezwrld/ezbase'

const ez = new EzBase({ url: 'http://localhost:7003' })

await ez.collection('todos').add({ title: 'Ship it', done: false })
const todos = await ez.collection('todos').where('done', '==', false).get()
const titles = await ez.collection('todos').select('title').get()

// Realtime
ez.collection('todos').onSnapshot((docs) => render(docs))
```

Collections are created on first write — no schema, no migrations. Admin console at `http://localhost:7003/console` (admin key prints in the logs on first boot).

## Auth and access rules

Email/password auth works with no configuration; OAuth providers (Google, GitHub, Microsoft, Apple) are enabled via env vars. Access control is one JSON file (`rules.json`), editable in the console:

```json
{
  "default": { "read": "public", "write": "authenticated" },
  "collections": {
    "api_keys": "owner",
    "invoices": { "access": "authenticated", "filter": { "orgId": "claims.orgId" } },
    "reports":  { "read": "role:admin", "write": "admin" }
  }
}
```

Rule filters are applied to queries automatically and enforced on writes: in an `owner` collection, `add({ name })` gets `userId` set server-side from the session, reads return only the caller's documents, and writes outside the caller's scope are rejected. Details and recipes: [docs/RULES.md](docs/RULES.md).

## Features

- **Documents** — schemaless JSONB, per-collection Postgres tables, `where`/`orderBy`/`limit` queries, typed top-level `select`
- **Realtime** — SSE subscriptions on collections, queries, or single documents
- **Auth** — email/password, OAuth, sessions, roles, custom claims, password reset (SMTP or logged links), admin user management, always-on brute-force rate limiting
- **Rules** — per-collection read/write permissions with owner/role/claim filters, enforced on reads and writes; secure defaults on fresh instances
- **File storage** — buckets with the same permission model
- **Backups** — streaming tar.gz (JSONL per collection + manifest), granular and query-filtered restore, pipeable: `ez backup | aws s3 cp - s3://…`
- **Analytics** — per-minute request metrics and a live request feed in the console
- **Multi-database** — isolated databases per instance, shared auth
- **SDK** — zero-dependency TypeScript, works in Node/Bun/Deno/browsers

## Using with AI agents

The complete reference is one file, written to be consumed by agents:

```
https://raw.githubusercontent.com/ezwrld/ezbase/master/docs/skill.md
```

[`llms.txt`](llms.txt) lists all reference URLs. Running instances report their version at `GET /api/health`; [`CHANGELOG.md`](CHANGELOG.md) documents upgrade considerations per release. Versioning is `major.minor`: minor releases are additive; breaking changes only occur in a new major and are marked in the changelog.

## Docs

- [docs/skill.md](docs/skill.md) — complete reference: SDK, REST API, auth, rules, storage, backups
- [docs/RULES.md](docs/RULES.md) — access rules and security model
- [docs/OAUTH-PROVIDERS.md](docs/OAUTH-PROVIDERS.md) — acquiring OAuth provider credentials
- [docs/BACKUPS.md](docs/BACKUPS.md) — backup and restore
- [CHANGELOG.md](CHANGELOG.md) — releases and upgrade considerations

## Development

```bash
git clone https://github.com/ezwrld/ezbase.git && cd ezbase
source setup.sh && ez up
```

## Roadmap

- [x] Documents + queries + realtime + multi-database
- [x] Auth, roles, claims, password management
- [x] Rules with write-scope enforcement
- [x] File storage with bucket permissions
- [x] Backups & restore
- [x] Request analytics + console Activity page
- [x] 1.0
- [ ] Type inference — generate TypeScript types from live data, with conformance reporting
- [ ] Full-text search (Meilisearch)
- [ ] Backup scheduling, restore points, S3 push

## License

MIT
