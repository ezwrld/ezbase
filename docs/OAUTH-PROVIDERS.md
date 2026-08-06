# OAuth Provider Setup

How to acquire client credentials for each supported provider and wire them into ezbase.

Every provider follows the same shape:

1. Create an OAuth app in the provider's developer console
2. Register the **callback URL**: `{EZBASE_URL}/api/auth/callback/{provider}`
   (e.g. `https://myapp.com/api/auth/callback/google` — or `http://localhost:7003/api/auth/callback/google` for local dev)
3. Copy the client ID + secret into your ezbase env vars
4. Restart the container — the provider appears in `GET /api/auth/providers` and `ez.auth.signInWithProvider(...)` works

`EZBASE_URL` must be set to your public URL — it's both the trusted browser origin and the base for callback URLs.

---

## Google

Env: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`

1. Go to [console.cloud.google.com](https://console.cloud.google.com) → create (or pick) a project
2. **APIs & Services → OAuth consent screen**: configure it (External audience for public apps). App name + support email is enough to start; you can stay in "Testing" mode with listed test users until you publish.
3. **APIs & Services → Credentials → Create Credentials → OAuth client ID**
   - Application type: **Web application**
   - Authorized redirect URIs: `{EZBASE_URL}/api/auth/callback/google`
4. Copy the **Client ID** and **Client secret**

Localhost callback URLs are allowed, so this works in dev.

## GitHub

Env: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`

1. GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**
   (org-owned apps: same path under the org's settings)
2. Homepage URL: your app. **Authorization callback URL**: `{EZBASE_URL}/api/auth/callback/github`
3. Register, then **Generate a new client secret**
4. Copy the **Client ID** and the secret

Simplest of the four — two minutes, localhost fine.

## Microsoft

Env: `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`

1. [entra.microsoft.com](https://entra.microsoft.com) → **App registrations → New registration**
2. Supported account types: "Accounts in any organizational directory and personal Microsoft accounts" for a general-public app
3. Redirect URI: platform **Web**, value `{EZBASE_URL}/api/auth/callback/microsoft`
4. After registering: **Certificates & secrets → New client secret** — copy the secret **Value** immediately (it's only shown once)
5. `MICROSOFT_CLIENT_ID` = the **Application (client) ID** from the Overview page

Note: client secrets expire (max 24 months) — calendar a rotation.

## Apple

Env: `APPLE_CLIENT_ID`, `APPLE_CLIENT_SECRET`

Apple is the involved one — requires a paid Apple Developer account, HTTPS-only callbacks (no localhost), and the "client secret" is a **JWT you generate yourself**, not a value Apple hands you.

1. [developer.apple.com](https://developer.apple.com/account) → **Certificates, Identifiers & Profiles → Identifiers**
2. Create an **App ID** with the "Sign in with Apple" capability
3. Create a **Services ID** (this is your `APPLE_CLIENT_ID`, e.g. `com.myapp.web`) — enable Sign in with Apple on it, configure your domain and the return URL `{EZBASE_URL}/api/auth/callback/apple`
4. **Keys → Create a key** with "Sign in with Apple" enabled → download the `.p8` file (once!), note the **Key ID** and your **Team ID** (top-right of the account page)
5. Generate the client secret — an ES256-signed JWT with `iss` = Team ID, `sub` = Services ID, `aud` = `https://appleid.apple.com`, expiry ≤ 6 months, signed with the `.p8` key. Quickest path:
   ```bash
   npx apple-signin-auth-cli --help   # or any "apple client secret generator" script
   ```
   or ~10 lines with the `jose` library. Set the output as `APPLE_CLIENT_SECRET`.
6. The JWT expires (6-month max) — regenerate and update the env var on a schedule.

Skip Apple unless you're shipping an iOS app or specifically want it — Google + GitHub cover most audiences with a fraction of the ceremony.

---

## After setup

```typescript
// Check what's live
const { providers } = await ez.auth.listProviders()  // → ['google', 'github']

// Browser sign-in
ez.auth.signInWithProvider('google', { callbackURL: '/dashboard' })

// After redirect back, on page load:
const session = await ez.auth.getSession()
```

Accounts with the same verified email auto-link across providers (email/password + Google = one user).

**Troubleshooting**
- `redirect_uri_mismatch` — the callback URL registered with the provider doesn't exactly match `{EZBASE_URL}/api/auth/callback/{provider}`. Check protocol, host, port, and that `EZBASE_URL` is set.
- Provider missing from `/api/auth/providers` — both env vars must be set; restart the container after changing env.
- 403 `INVALID_ORIGIN` on sign-in from your frontend — your app's domain isn't `EZBASE_URL`; add it to `EZBASE_TRUSTED_ORIGINS`.
