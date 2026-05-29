# Distribution & Self-Hosting

How ezbase gets packaged, published, and used in projects.

---

## Two artifacts

| Artifact | Registry | What it is |
|----------|----------|------------|
| `@ezwrld/ezbase` npm package | npmjs.com | The TypeScript SDK — `npm install @ezwrld/ezbase` |
| `ghcr.io/ezwrld/ezbase` Docker image | GitHub Container Registry | The all-in-one server (postgres, API, console, nginx) |

The SDK is useless without the server. The server is useless without the SDK (or raw curl). They're versioned independently because the SDK changes more often.

---

## Using ezbase in a project

### 1. Add the Docker image to your compose stack

```yaml
# your-project/docker-compose.yml
services:
  app:
    build: .
    ports:
      - "3000:3000"

  ezbase:
    image: ghcr.io/ezwrld/ezbase:latest
    ports:
      - "7003:7003"
    volumes:
      - ezbase-data:/data

volumes:
  ezbase-data:
```

One service. One port. One volume. Same deployment shape as adding Redis or Meilisearch, but with ezbase owning the durable app data.

### 2. Install the SDK

```bash
npm install @ezwrld/ezbase
```

### 3. Use it

```typescript
import { EzBase } from '@ezwrld/ezbase'

const ez = new EzBase({ url: 'http://localhost:7003' })

await ez.collection('todos').doc('abc').set({ title: 'Ship it', done: false })
const todo = await ez.collection('todos').doc('abc').get()
```

---

## What the Docker image contains

Everything runs inside one container via supervisord:

- **PostgreSQL 16** — document storage
- **Bun API server** — Hono REST API on internal port 8080
- **Console** — pre-built React SPA (static files)
- **Nginx** — reverse proxy, exposes port 7003

All data lives under `/data`:
```
/data/
├── postgres/    # pg data directory
└── files/       # uploaded files
```

Mount one volume at `/data` and everything persists.

---

## One instance per project

Each project gets its own ezbase container + volume. No multi-tenancy, no shared state. If you nuke a project, its ezbase goes with it. Simple.

---

## Releasing

Automatic on merge to master. GitHub Actions detect what changed:

- `sdk/**` changed → bumps SDK patch version, publishes to npm, tags `sdk-vX.X.X`
- `server/**`, `console/**`, `nginx/**`, `docker/**`, or `Dockerfile` changed → bumps image patch version, pushes to GHCR, tags `vX.X.X`
- Both changed → both workflows run

---

## One-time setup

### npm

Uses OIDC trusted publishing — no `NPM_TOKEN` needed. See `docs/CI-CD.md` for details.

### GitHub Container Registry

No extra setup — the `GITHUB_TOKEN` secret is automatic. The `publish-image.yml` workflow uses it to push to `ghcr.io`.

After the first image push, go to your package settings on GitHub and make it public if you want (it defaults to your repo's visibility).

---

## Local dev vs production

| | Local dev (`ez up`) | Production (single image) |
|---|---|---|
| How it runs | `docker-compose.yml` — separate containers | Single container via supervisord |
| Console | Vite dev server (HMR) | Pre-built static files served by nginx |
| Nginx config | `nginx/nginx.conf` (proxies to Vite) | `docker/nginx.prod.conf` (serves static) |
| Data | Separate named volumes per service | Single `/data` volume |
| Use case | Working on ezbase itself | Using ezbase in other projects |

You never use the all-in-one image for ezbase development. `ez up` with compose is the dev workflow. The single image is purely the distribution format.
