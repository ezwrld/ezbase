# Auth — BetterAuth Integration

**Status:** Implemented. Email/password + OAuth providers (Google, GitHub, Microsoft, Apple).

## Why BetterAuth

ezbase's philosophy: don't reimplement solved problems. Auth is solved. BetterAuth is:
- A library you embed, not a service
- Stores everything in your Postgres (no external dependency)
- First-class Hono integration
- Handles OAuth, 2FA, sessions, password reset — stuff we'd never build ourselves
- The user never knows BetterAuth exists. They just call `ez.auth.signIn()`.

## What changes

### Auth (BetterAuth — implemented)
- BetterAuth handles all user management, sessions, OAuth callbacks
- Mounts its routes at `/api/auth/*` inside the Hono app
- ezbase middleware reads BetterAuth's session to get user identity
- Permission system (public/authenticated/admin) stays — it's ours, not BetterAuth's

## Server implementation

### Install
```bash
cd server
bun add better-auth
```

### Configure (`server/src/auth.ts` — rewritten)
```typescript
import { betterAuth } from 'better-auth'

export const auth = betterAuth({
  database: {
    type: 'postgres',
    url: process.env.DATABASE_URL,
  },
  emailAndPassword: {
    enabled: true,
  },
  socialProviders: {
    // Only enabled if env vars are set
    ...(process.env.GOOGLE_CLIENT_ID && {
      google: {
        clientId: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      },
    }),
    ...(process.env.GITHUB_CLIENT_ID && {
      github: {
        clientId: process.env.GITHUB_CLIENT_ID,
        clientSecret: process.env.GITHUB_CLIENT_SECRET,
      },
    }),
  },
})
```

### Mount in Hono (`server/src/index.ts`)
```typescript
import { auth } from './auth.js'

// BetterAuth handles all /api/auth/* routes
app.on(['POST', 'GET'], '/api/auth/**', (c) => auth.handler(c.req.raw))
```

### Middleware (`server/src/middleware.ts` — updated)
```typescript
// Instead of verifying our own JWT, ask BetterAuth for the session
const session = await auth.api.getSession({ headers: c.req.raw.headers })
if (session) {
  c.set('userId', session.user.id)
  c.set('role', session.user.role ?? 'user')
} else {
  c.set('role', 'anonymous')
}
```

## SDK surface

```typescript
// Email/password — works out of the box, zero config
await ez.auth.signUp({ email, password })
await ez.auth.signIn({ email, password })
await ez.auth.signOut()
const user = ez.auth.currentUser

// OAuth — works if provider env vars are set on the server
ez.auth.signInWithProvider('google', { callbackURL: '/dashboard' })
// → redirects to Google → user approves → redirects back

// Restore session after OAuth redirect
const session = await ez.auth.getSession()

// Check available providers
const { providers, emailPassword } = await ez.auth.listProviders()

// State changes
ez.auth.onAuthStateChanged((user) => { ... })
```

### SDK implementation
- `AuthClient` calls BetterAuth's standard endpoints (`/api/auth/sign-up`, `/api/auth/sign-in/email`, etc.)
- Session management uses BetterAuth's session cookies/tokens
- `signInWithProvider()` redirects to BetterAuth's `/sign-in/social` endpoint (browser-only)
- `getSession()` fetches current session from BetterAuth after OAuth redirect
- `listProviders()` hits custom `/api/auth/providers` endpoint

### Account linking
- BetterAuth auto-links accounts with the same email from trusted providers (Google, GitHub, Microsoft, Apple)
- User signs up with email → later signs in with Google (same email) → same user, two auth methods
- Configured via `account.accountLinking` in BetterAuth options

## Docker env vars

```yaml
ezbase:
  image: ghcr.io/ezwrld/ezbase:latest
  ports:
    - "7003:7003"
  volumes:
    - ezbase-data:/data
  environment:
    BETTER_AUTH_URL: "https://myapp.com"    # required for OAuth (callback URLs)
    GOOGLE_CLIENT_ID: "..."
    GOOGLE_CLIENT_SECRET: "..."
    GITHUB_CLIENT_ID: "..."
    GITHUB_CLIENT_SECRET: "..."
    MICROSOFT_CLIENT_ID: "..."
    MICROSOFT_CLIENT_SECRET: "..."
    APPLE_CLIENT_ID: "..."
    APPLE_CLIENT_SECRET: "..."
```

No env vars = email/password only. Add provider credentials = OAuth just works. Zero code changes.

OAuth callback URL to register with each provider: `{BETTER_AUTH_URL}/api/auth/callback/{provider}`

## Custom Claims & Roles

Users have a `role` (TEXT, default `"user"`) and `claims` (TEXT, serialized JSON, default `"{}"`) column on BetterAuth's `user` table (added via `additionalFields`). BetterAuth's `runMigrations()` auto-adds the column.

### User management endpoints (admin only)

All require admin key or `role: "admin"`. Registered in `server/src/auth.ts` before the BetterAuth catch-all:

| Method | Path | Body | Description |
|--------|------|------|-------------|
| GET | `/auth/users` | — | List users (`?limit=&offset=`) |
| GET | `/auth/users/:id` | — | Get user by ID |
| PUT | `/auth/users/:id/role` | `{ role: "mover" }` | Set role |
| PUT | `/auth/users/:id/claims` | `{ orgId: "123" }` | Replace claims |
| PATCH | `/auth/users/:id/claims` | `{ tier: "pro" }` | Merge claims (null deletes key) |
| DELETE | `/auth/users/:id` | — | Delete user + sessions + accounts |

Self-deletion guard: admin can't delete their own account.

### Middleware

`extractAuth()` parses claims from the BetterAuth session and sets `c.set('claims', ...)`. Admin key gets empty claims.

### SDK

```typescript
const admin = new EzBase({ url: '...', adminKey: '...' })

await admin.auth.setRole('user-123', 'mover')
await admin.auth.setClaims('user-123', { orgId: 'auburn' })
await admin.auth.mergeClaims('user-123', { tier: 'pro' })
const users = await admin.auth.listUsers()
const user = await admin.auth.getUser('user-123')
await admin.auth.deleteUser('user-789')

// After sign-in, claims are parsed automatically
const ez = new EzBase({ url: '...' })
await ez.auth.signIn({ email, password })
ez.auth.currentUser.role    // "mover"
ez.auth.currentUser.claims  // { orgId: "auburn", tier: "pro" }
```

## Permission model

BetterAuth answers: **"who is this person?"**
ezbase answers: **"what can they access?"**

Permissions are defined in `rules.json` — a single file per ezbase instance.

Per-collection permission levels:
- `public` — no auth needed
- `authenticated` — any logged-in user
- `role:<name>` — only users with matching role (e.g. `role:mover`)
- `owner` — sugar for `{ access: "authenticated", filter: { userId: "auth.id" } }`
- `admin` — admin key or users with `role: "admin"`

Users with `role: 'admin'` pass admin-level permission checks (same as admin key).

### Claims + Rules Filter Interaction

Rules can include **filters** that map document fields to auth context values. When a user makes a request, the server resolves filters against their claims and automatically applies WHERE clauses to queries.

```json
{
  "collections": {
    "move_orders": {
      "access": "role:mover",
      "filter": { "orgId": "claims.orgIds" }
    }
  }
}
```

If user has `claims: { orgIds: ["auburn", "oxford"] }`:
- GET `/collections/move_orders` → only returns docs where `data.orgId` is `"auburn"` or `"oxford"`
- GET `/collections/move_orders/:id` → returns 404 if doc's orgId doesn't match
- PUT/PATCH/DELETE on a doc → returns 404 if doc doesn't match filter

Filter auth paths:
- `"auth.id"` → user's ID (string equality)
- `"claims.foo"` → user's claim value. Array → SQL `ANY()`, string/number → equality
- Undefined/null claim → request denied (403) — user can't match any docs
- Multiple filter keys → AND logic (all must match)

## Migration path

1. Install `better-auth` in server
2. Rewrite `server/src/auth.ts` with BetterAuth config
3. Update middleware to read BetterAuth sessions
4. Remove old JWT generation/verification code
5. Update SDK `AuthClient` to call BetterAuth endpoints
6. BetterAuth auto-creates its tables in Postgres on first run
7. Test signup/signin/OAuth flows

## What we delete
- Manual bcrypt hashing
- Manual JWT generation/verification
- `_ezbase_users` table (BetterAuth manages its own user table)
- JWT_SECRET env var (BetterAuth handles its own secrets)
