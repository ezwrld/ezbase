# Feature Toggles

Status: **Ideation**

## Problem

ezbase ships with everything enabled (auth, storage, documents). If you're only using it as a document store, BetterAuth is still initializing, storage routes are still mounted, and the console shows UI for features you don't use. Unnecessary overhead and surface area.

## Goals

- Disable unused features (auth, storage) via env vars
- Disabled features don't initialize (no BetterAuth setup, no storage tables)
- API routes for disabled features return 404 or 501
- Console hides UI for disabled features
- Zero config by default — everything on, opt-out model

## Proposed Config

```
EZBASE_AUTH=true          # default: true
EZBASE_STORAGE=true       # default: true
```

When `EZBASE_AUTH=false`:
- BetterAuth not initialized, no auth tables created
- `/api/auth/*` routes return 501
- Permission checks treat all requests as admin (or use admin key only)
- Console hides auth/users section
- `rules.json` auth-based permissions (authenticated, owner, role:*) are unavailable

When `EZBASE_STORAGE=false`:
- `_ezbase_files` table not created, storage directory not initialized
- `/api/storage/*` routes return 501
- Console hides storage browser
- `rules.json` buckets section ignored

## Considerations

- What happens if you disable auth on an instance that already has users? Probably fine — tables stay, just aren't accessed. Re-enabling brings them back.
- Should disabled features be visible in `/api/health` response? e.g., `{ "auth": false, "storage": false }`
- Console could show a subtle indicator for disabled features rather than hiding them entirely (e.g., greyed out with "Disabled" label)
- Admin key becomes the only auth mechanism when auth is disabled — make sure this is clearly documented

## Open Questions

- Should there be a `EZBASE_CONSOLE=false` to disable the admin console entirely?
- Should disabled features be configurable at runtime (via API/console) or only at startup (env vars)?
- Any other features that should be toggleable? (e.g., real-time SSE, multi-database)
