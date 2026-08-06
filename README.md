# ezbase

**The entire backend for a small SaaS in one Docker container.** Document database, auth, permissions, file storage, realtime, backups, analytics — self-hosted on your box, wrapped in a Firebase-grade SDK.

```typescript
const ez = new EzBase({ url: 'https://ez.yourapp.com' })
await ez.collection('todos').add({ title: 'Ship it', done: false })
```

That's a real write to a real Postgres. No schema, no migrations, no ORM, no cloud bill.

## Why it's good

**It's glue, not a new database.** ezbase doesn't reimplement hard problems — it wires battle-tested tools together behind one dead-simple API: **Postgres** (JSONB + GIN indexes) does storage and querying, **BetterAuth** does sessions, password hashing, and OAuth, **nginx** fronts it. You get the reliability of boring infrastructure with the DX of Firebase — and none of the lock-in.

**Rules that do the work for you.** Declare who can touch what in one JSON file — and unlike Firestore, the rules *are* the query, and writes are scoped automatically:

```json
{ "collections": { "api_keys": "owner" } }
```

```typescript
// Signed-in user. Note: no uid handling ANYWHERE.
await ez.collection('api_keys').add({ name: 'prod', key })  // userId stamped server-side
const mine = await ez.collection('api_keys').get()          // only this user's keys
```

Users can't read each other's docs, can't create docs as someone else, can't move docs across scope boundaries. Roles (`role:admin`), multi-tenant claims (`orgId`), and public/authenticated splits included. Fresh instances are locked down by default.

**Auth out of the box, zero config.** `ez.auth.signUp({ email, password })` works on a fresh container. Add env vars when you want Google/GitHub/Microsoft/Apple sign-in, SMTP password-reset emails, or email verification. Brute-force rate limiting is always on.

**Your data stays yours.** `ez backup` streams one inspectable tar.gz — pipe it to your laptop or S3 (`ez backup | aws s3 cp - s3://…`). Restore everything, one collection, or "just the docs matching this query from before things went wrong." Any machine can open the archive with plain `tar`.

**You can see what's happening.** Built-in analytics (per-minute request metrics, per-collection traffic, live request feed) and an admin console: browse documents live, edit rules, manage users and files.

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
const todos = await ez.collection('todos').get()

// Realtime
ez.collection('todos').onSnapshot((docs) => render(docs))
```

Console at `http://localhost:7003/console` (admin key prints in the logs on first boot).

## What's inside

- **Documents** — schemaless JSONB, collections created on first write, `where/orderBy/limit` queries
- **Realtime** — SSE subscriptions on collections, queries, or single docs
- **Auth** — email/password + OAuth, sessions, roles, custom claims, password reset, admin user management
- **Rules** — per-collection read/write permissions with owner/role/claim filters, enforced on reads *and* writes
- **File storage** — buckets with the same permission model
- **Backups** — streaming tar.gz, granular + query-filtered restore, pipeable off-box
- **Analytics** — request metrics + live activity feed in the console
- **Multi-database** — isolated databases per instance, shared auth
- **SDK** — zero-dependency TypeScript, works in Node/Bun/Deno/browsers; plus a plain REST API for everything else

## Building with AI agents

Give your agent one URL and it knows the whole system:

```
Set up ezbase in this project: https://raw.githubusercontent.com/ezwrld/ezbase/master/docs/skill.md
```

[`llms.txt`](llms.txt) lists every reference. Running instances report their version at `/api/health`; [`CHANGELOG.md`](CHANGELOG.md) carries upgrade considerations for every release — minor versions never break, breaking changes only ever land in a new major.

## Docs

- [**docs/skill.md**](docs/skill.md) — the complete reference: SDK, REST API, auth, rules, storage, backups
- [docs/RULES.md](docs/RULES.md) — security & permissions, with Firebase-rule translations
- [docs/OAUTH-PROVIDERS.md](docs/OAUTH-PROVIDERS.md) — getting Google/GitHub/Microsoft/Apple credentials
- [docs/BACKUPS.md](docs/BACKUPS.md) — backup & restore
- [CHANGELOG.md](CHANGELOG.md) — releases + upgrade considerations

## Development

```bash
git clone https://github.com/ezwrld/ezbase.git && cd ezbase
source setup.sh && ez up
```

## Roadmap

- [x] Documents + queries + realtime + multi-database
- [x] Auth (BetterAuth), roles, claims, password management
- [x] Rules with write-scope enforcement + secure defaults
- [x] File storage with bucket permissions
- [x] Backups & restore
- [x] Built-in analytics + console Activity page
- [x] 1.0
- [ ] Type inference — generate TypeScript types from your live data, with conformance reporting
- [ ] Full-text search (Meilisearch)
- [ ] Backup scheduling, restore points, S3 push

## License

MIT
