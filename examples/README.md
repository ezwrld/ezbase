# ezbase examples

Working examples that demonstrate how to build with ezbase.

## Prerequisites

1. ezbase running at `http://localhost:7003` (use the test stack or your own)
2. SDK installed: `npm install @ezwrld/ezbase`

### Quick start with the test stack

```bash
cd test/
docker compose up -d --build
# Wait ~15s for postgres init
curl http://localhost:7003/api/health  # should return {"status":"ok"}
```

## Examples

| File | What it covers |
|------|---------------|
| `01-basic-crud.ts` | Create, read, update, replace, delete documents |
| `02-queries.ts` | Filtering, sorting, pagination with `.where()`, `.orderBy()`, `.limit()` |
| `03-auth-flow.ts` | Sign up, sign in, authenticated requests, permissions, sign out |
| `04-realtime.ts` | Collection and document-level SSE subscriptions |
| `05-server-side.ts` | Backend patterns: user profiles, task queues, event logging |

## Running

```bash
# From the repo root
bun run examples/01-basic-crud.ts
bun run examples/02-queries.ts
# etc.
```

Each example is self-contained. Run them against a fresh ezbase instance (`docker compose down -v && docker compose up -d` to reset).
