# CI/CD

ezbase has two GitHub Actions workflows that auto-publish on merge to master.

---

## SDK — `publish-sdk.yml`

**Trigger:** Any push to `master` that changes files in `sdk/`.

**What it does:**
1. Bumps `sdk/package.json` patch version (0.1.2 → 0.1.3)
2. Builds the SDK (`tsc`)
3. Publishes to npm as `@ezwrld/ezbase` using OIDC trusted publishing (no token needed)
4. Commits the version bump back to master
5. Tags `sdk-v0.1.3` and pushes the tag

**Auth:** Uses npm's OIDC trusted publishing. No `NPM_TOKEN` secret needed. The `id-token: write` permission lets GitHub Actions authenticate directly with npm.

**npm trusted publisher config:**
- Owner: `ezwrld`
- Repository: `ezbase`
- Workflow: `publish-sdk.yml`
- Environment: (blank)

This is configured at npmjs.com → `@ezwrld/ezbase` → Settings → Trusted Publishers.

**Requirements:**
- npm CLI v11.5.1+ (the workflow upgrades npm automatically)
- Node 22 (for the build step)

---

## Docker Image — `publish-image.yml`

**Trigger:** Any push to `master` that changes files in `server/`, `console/`, `nginx/`, `docker/`, or `Dockerfile`.

**What it does:**
1. Determines next version by finding the latest `v*` tag and bumping patch
2. Builds the all-in-one Docker image from the root `Dockerfile`
3. Pushes to GitHub Container Registry as `ghcr.io/ezwrld/ezbase:X.X.X` + `:latest`
4. Tags `vX.X.X` and pushes the tag

**Auth:** Uses the built-in `GITHUB_TOKEN` — no extra secrets needed. The `packages: write` permission grants GHCR access.

**What's in the image:**
- PostgreSQL 16 (data storage, LISTEN/NOTIFY for pub/sub)
- Bun (runs the Hono API server)
- Nginx (reverse proxy, serves console static files)
- Supervisord (process manager)
- Pre-built React console (static files)

All managed by supervisord, exposed on port 7003, data at `/data`.

---

## Version tags

| Tag format | What it is |
|-----------|-----------|
| `sdk-v0.1.3` | SDK version published to npm |
| `v0.0.5` | Docker image version pushed to GHCR |

SDK and image versions are independent. Both auto-increment patch on every qualifying merge.

---

## Triggering a release

Just merge to master. If your PR touches `sdk/` files, the SDK publishes. If it touches server/console/docker files, the image builds. If both, both run.

No manual tagging. No release scripts. No tokens to rotate.

---

## First-time setup

These were done once and don't need to be repeated:

1. **npm package created** — first publish was done manually (`cd sdk && npm publish --access public`)
2. **Trusted publisher configured** — on npmjs.com, linked `ezwrld/ezbase` repo + `publish-sdk.yml` workflow
3. **GHCR** — no setup needed, uses `GITHUB_TOKEN` automatically
4. **npm 2FA** — required for first manual publish, not needed for OIDC
