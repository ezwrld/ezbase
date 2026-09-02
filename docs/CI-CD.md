# CI/CD

ezbase validates pull requests, then uses two publishing workflows after merge to `master`.

---

## Pull request validation — `ci.yml`

**Trigger:** Every pull request targeting `master`, plus manual dispatch.

The `Release gate` job must pass before merge. It:

1. Strictly type-checks, bundles, and tests the server
2. Builds the console with its production TypeScript settings
3. Builds and tests the SDK
4. Builds the root all-in-one Docker image that the release workflow will publish

Repository rules must require a pull request and the `Release gate` status check for `master`.
Also block force pushes and do not allow bypassing the rule. The workflow alone reports failures;
the repository rule is what prevents a failing or unchecked PR from merging.

---

## SDK — `publish-sdk.yml`

**Trigger:** Any push to `master` that changes files in `sdk/`.

**What it does:**
1. Uses the unpublished `sdk/package.json` version, or bumps its minor version when that version already exists on npm
2. Builds the SDK (`tsc`)
3. Publishes to npm as `@ezwrld/ezbase` using OIDC trusted publishing (no token needed)
4. Commits the version bump back to master
5. Tags `sdk-vX.Y.0` and pushes the tag

**Auth:** Uses npm's OIDC trusted publishing. No `NPM_TOKEN` secret needed. The `id-token: write` permission lets GitHub Actions authenticate directly with npm.

**npm trusted publisher config:**
- Owner: `ezwrld`
- Repository: `ezbase`
- Workflow: `publish-sdk.yml`
- Environment: (blank)

This is configured at npmjs.com → `@ezwrld/ezbase` → Settings → Trusted Publishers.

**Requirements:**
- npm CLI v11.5.1+
- Node 24 (for the build step)

---

## Docker Image — `publish-image.yml`

**Trigger:** Any push to `master` that changes files in `server/`, `console/`, `nginx/`, `docker/`, or `Dockerfile`.

**What it does:**
1. Determines next version by finding the latest `v*` tag and bumping **minor** (`1.6` → `1.7`)
2. Builds the all-in-one Docker image from the root `Dockerfile`
3. Pushes to GitHub Container Registry as `ghcr.io/ezwrld/ezbase:X.Y` + `:latest`
4. Tags `vX.Y` and pushes the tag

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
| `sdk-v1.5.0` | SDK version published to npm |
| `v1.8` | Docker image version pushed to GHCR |

SDK and image versions are independent. Both auto-increment the minor version on every qualifying merge.

---

## Triggering a release

Open a pull request to `master` and wait for the required `Release gate` check. After it passes and the PR merges, SDK changes publish the SDK and server/console/docker changes publish the image. If both changed, both publishing workflows run.

**Changelog is the user-facing contract.** The PR must include `## vX.Y` matching the version that will be tagged (current latest image tag + one minor). The image workflow copies that section into the GitHub Release. Include **Upgrade considerations** and an **Agent prompt** (pin `ghcr.io/ezwrld/ezbase:X.Y`, `GET /api/health`, SDK version). Do not tell consuming apps to upgrade until the publish workflow is green.

No manual tagging. No release scripts. No tokens to rotate.

---

## First-time setup

These were done once and don't need to be repeated:

1. **npm package created** — first publish was done manually (`cd sdk && npm publish --access public`)
2. **Trusted publisher configured** — on npmjs.com, linked `ezwrld/ezbase` repo + `publish-sdk.yml` workflow
3. **GHCR** — no setup needed, uses `GITHUB_TOKEN` automatically
4. **npm 2FA** — required for first manual publish, not needed for OIDC
