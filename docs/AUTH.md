# Auth — BetterAuth Integration Plan

**Status:** Implemented. Replaced the hand-rolled JWT + bcrypt auth.

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

The SDK auth API stays the same from the developer's perspective:

```typescript
// Email/password — works out of the box, zero config
await ez.auth.signUp({ email, password })
await ez.auth.signIn({ email, password })
await ez.auth.signOut()
const user = ez.auth.currentUser

// OAuth — works if provider env vars are set on the server
await ez.auth.signIn({ provider: 'google' })
await ez.auth.signIn({ provider: 'github' })

// State changes
ez.auth.onAuthStateChanged((user) => { ... })
```

Under the hood, the SDK calls BetterAuth's endpoints instead of our custom ones. The developer never knows.

### SDK implementation changes
- `AuthClient` calls BetterAuth's standard endpoints (`/api/auth/sign-up`, `/api/auth/sign-in/email`, etc.)
- Session management uses BetterAuth's session cookies/tokens
- OAuth flows redirect through BetterAuth's callback handling

## Docker env vars

```yaml
ezbase:
  image: ghcr.io/ezwrld/ezbase:latest
  ports:
    - "7003:7003"
  volumes:
    - ezbase-data:/data
  environment:
    # Optional — OAuth providers light up when these are set
    GOOGLE_CLIENT_ID: "..."
    GOOGLE_CLIENT_SECRET: "..."
    GITHUB_CLIENT_ID: "..."
    GITHUB_CLIENT_SECRET: "..."
```

No env vars = email/password only. Add provider credentials = OAuth just works. Zero code changes.

## Permission model (unchanged)

BetterAuth answers: **"who is this person?"**
ezbase answers: **"what can they access?"**

The per-collection permission levels stay exactly as they are:
- `public` — no auth needed
- `authenticated` — any logged-in user
- `admin` — admin key only

The `filtered` mode (user can only see their own docs) is a future addition built on top.

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
