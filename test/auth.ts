/**
 * ezbase Auth & Authorization test suite.
 *
 * Covers every auth code path testable without external OAuth providers:
 * identity, permission levels, role-based access, owner rules, claim filters,
 * filter enforcement on mutations, bucket permissions, user management auth,
 * provider detection, and session lifecycle.
 *
 * Usage:
 *   bun run test/auth.ts
 *   URL=http://localhost:7003 ADMIN_KEY=... bun run test/auth.ts
 *
 * Expects: a fresh ezbase instance (ez down --nuke && ez up, or test docker-compose).
 */

import { EzBase } from '../sdk/src/index.js'

const URL = process.env.URL || 'http://localhost:7003'
const ADMIN_KEY = process.env.ADMIN_KEY || 'test-admin-key'

let passed = 0
let failed = 0
const failures: string[] = []

function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`  ✓ ${msg}`)
    passed++
  } else {
    console.error(`  ✗ ${msg}`)
    failed++
    failures.push(msg)
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitForHealthy(retries = 30) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${URL}/api/health`)
      if (res.ok) return
    } catch {}
    await sleep(2000)
  }
  throw new Error('ezbase did not become healthy in time')
}

async function apiFetch(path: string, opts: RequestInit = {}) {
  const headers = new Headers(opts.headers)
  if (!headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${ADMIN_KEY}`)
  }
  return fetch(`${URL}/api${path}`, { ...opts, headers })
}

/** Set rules via admin API, restoring to public default on failure */
async function setRules(rules: Record<string, unknown>) {
  const res = await apiFetch('/rules', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_KEY}` },
    body: JSON.stringify(rules),
  })
  if (!res.ok) throw new Error(`setRules failed: ${res.status}`)
}

async function resetRules() {
  await setRules({ default: 'public' })
}

// ── Helpers ──────────────────────────────────────────────────

const admin = new EzBase({ url: URL, adminKey: ADMIN_KEY })

/** Create a user, optionally set role + claims, return a signed-in client */
async function createUser(
  email: string,
  opts?: { role?: string; claims?: Record<string, unknown> }
): Promise<{ client: EzBase; userId: string }> {
  const client = new EzBase({ url: URL })
  const { user } = await client.auth.signUp({ email, password: 'testpass123' })

  if (opts?.role) await admin.auth.setRole(user.id, opts.role)
  if (opts?.claims) await admin.auth.setClaims(user.id, opts.claims)

  // Re-signin to pick up role/claims changes
  if (opts?.role || opts?.claims) {
    await client.auth.signOut()
    await client.auth.signIn({ email, password: 'testpass123' })
  }

  return { client, userId: user.id }
}

// ── 1. Identity: /me endpoint ────────────────────────────────

async function testIdentity() {
  console.log('\n== Identity (/me) ==')

  // Admin key → admin pseudo-user
  const adminMe = await apiFetch('/auth/me')
  const adminBody = await adminMe.json()
  assert(adminMe.ok, 'admin key: /me returns 200')
  assert(adminBody.id === 'admin' && adminBody.role === 'admin', 'admin key: /me returns admin pseudo-user')

  // Anonymous → 401
  const anonMe = await fetch(`${URL}/api/auth/me`)
  assert(anonMe.status === 401, 'anonymous: /me returns 401')

  // Authenticated user → real user data
  const { client, userId } = await createUser('auth-me@test.com', {
    role: 'mover',
    claims: { orgId: 'auburn' },
  })
  const userMe = await client.auth.getSession()
  assert(userMe !== null, 'authenticated: getSession returns session')
  assert(client.auth.currentUser?.role === 'mover', 'authenticated: currentUser has correct role')
  assert((client.auth.currentUser as any)?.claims?.orgId === 'auburn', 'authenticated: currentUser has correct claims')
}

// ── 2. Provider detection ────────────────────────────────────

async function testProviders() {
  console.log('\n== Provider Detection ==')

  // No OAuth env vars configured in test → empty providers
  const res = await fetch(`${URL}/api/auth/providers`)
  const body = await res.json()
  assert(res.ok, 'GET /auth/providers returns 200')
  assert(Array.isArray(body.providers), 'providers is an array')
  assert(body.emailPassword === true, 'emailPassword is true')
  // In test env, no providers should be configured
  assert(body.providers.length === 0, 'no OAuth providers configured in test env')
}

// ── 3. Role-based access (role:*) ────────────────────────────

async function testRoleBasedAccess() {
  console.log('\n== Role-Based Access (role:*) ==')

  await setRules({
    default: 'public',
    collections: { auth_role_col: 'role:mover' },
  })

  // Seed data as admin
  const doc = await admin.collection('auth_role_col').add({ item: 'test' })

  // User with matching role → allowed
  const { client: mover } = await createUser('auth-mover@test.com', { role: 'mover' })
  const docs = await mover.collection('auth_role_col').get()
  assert(Array.isArray(docs) && docs.length >= 1, 'role:mover user can read role:mover collection')

  // Write with matching role
  const created = await mover.collection('auth_role_col').add({ item: 'mover-created' })
  assert(!!created.id, 'role:mover user can write to role:mover collection')

  // User with wrong role → 403
  const { client: viewer } = await createUser('auth-viewer@test.com', { role: 'viewer' })
  try {
    await viewer.collection('auth_role_col').get()
    assert(false, 'wrong role should be blocked from reading')
  } catch {
    assert(true, 'user with role:viewer gets 403 on role:mover collection')
  }

  // User with no custom role (default "user") → 403
  const { client: regular } = await createUser('auth-regular@test.com')
  try {
    await regular.collection('auth_role_col').get()
    assert(false, 'default role user should be blocked')
  } catch {
    assert(true, 'default role user gets 403 on role:mover collection')
  }

  // Anonymous → 401
  const anonRes = await fetch(`${URL}/api/collections/auth_role_col`)
  assert(anonRes.status === 401, 'anonymous gets 401 on role:mover collection')

  await resetRules()
}

// ── 4. Owner permission ──────────────────────────────────────

async function testOwnerPermission() {
  console.log('\n== Owner Permission ==')

  await setRules({
    default: 'public',
    collections: { auth_owner_col: 'owner' },
  })

  // User A creates docs with their userId
  const { client: userA, userId: idA } = await createUser('auth-owner-a@test.com')
  const docA = await userA.collection('auth_owner_col').add({ title: 'A-doc', userId: idA })
  assert(!!docA.id, 'user A can create in owner collection')

  // User A sees their doc
  const aDocs = await userA.collection('auth_owner_col').get()
  assert(aDocs.length === 1 && aDocs[0].data.userId === idA, 'user A sees only their own docs')

  // User B creates their own doc
  const { client: userB, userId: idB } = await createUser('auth-owner-b@test.com')
  await userB.collection('auth_owner_col').add({ title: 'B-doc', userId: idB })

  // User B only sees their doc
  const bDocs = await userB.collection('auth_owner_col').get()
  assert(bDocs.length === 1 && bDocs[0].data.userId === idB, 'user B sees only their own docs')

  // User B can't access user A's doc by ID (404, not 403)
  const crossAccess = await userB.collection('auth_owner_col').doc(docA.id).get()
  assert(crossAccess === null, 'user B gets null (404) for user A\'s doc')

  // User B can't update user A's doc
  try {
    await userB.collection('auth_owner_col').doc(docA.id).update({ title: 'hacked' })
    assert(false, 'user B should not be able to update user A\'s doc')
  } catch {
    assert(true, 'user B blocked from updating user A\'s doc')
  }

  // User B can't delete user A's doc
  try {
    await userB.collection('auth_owner_col').doc(docA.id).delete()
    assert(false, 'user B should not be able to delete user A\'s doc')
  } catch {
    assert(true, 'user B blocked from deleting user A\'s doc')
  }

  // Admin sees all docs
  const allDocs = await admin.collection('auth_owner_col').get()
  assert(allDocs.length >= 2, 'admin sees all docs in owner collection')

  // Anonymous → 401
  const anonRes = await fetch(`${URL}/api/collections/auth_owner_col`)
  assert(anonRes.status === 401, 'anonymous gets 401 on owner collection')

  await resetRules()
}

// ── 5. Array claim filters (SQL ANY) ─────────────────────────

async function testArrayClaimFilters() {
  console.log('\n== Array Claim Filters ==')

  await setRules({
    default: 'public',
    collections: {
      auth_arr_filter: { access: 'authenticated', filter: { orgId: 'claims.orgIds' } },
    },
  })

  // Seed docs with various orgIds
  await admin.collection('auth_arr_filter').add({ orgId: 'auburn', item: 'a1' })
  await admin.collection('auth_arr_filter').add({ orgId: 'oxford', item: 'o1' })
  await admin.collection('auth_arr_filter').add({ orgId: 'mobile', item: 'm1' })

  // User with array claim → sees matching docs via ANY()
  const { client } = await createUser('auth-arr@test.com', {
    claims: { orgIds: ['auburn', 'oxford'] },
  })

  const docs = await client.collection('auth_arr_filter').get()
  assert(docs.length === 2, `array claim filter returns 2 docs (got ${docs.length})`)
  const orgIds = docs.map((d: any) => d.data.orgId).sort()
  assert(orgIds[0] === 'auburn' && orgIds[1] === 'oxford', 'array claim matches auburn + oxford')

  // Admin sees all 3
  const allDocs = await admin.collection('auth_arr_filter').get()
  assert(allDocs.length === 3, 'admin sees all 3 docs')

  await resetRules()
}

// ── 6. Multiple filter keys (AND logic) ──────────────────────

async function testMultipleFilterKeys() {
  console.log('\n== Multiple Filter Keys (AND) ==')

  await setRules({
    default: 'public',
    collections: {
      auth_multi_filter: {
        access: 'authenticated',
        filter: { orgId: 'claims.orgId', region: 'claims.region' },
      },
    },
  })

  // Seed docs
  await admin.collection('auth_multi_filter').add({ orgId: 'auburn', region: 'south', val: 1 })
  await admin.collection('auth_multi_filter').add({ orgId: 'auburn', region: 'north', val: 2 })
  await admin.collection('auth_multi_filter').add({ orgId: 'oxford', region: 'south', val: 3 })

  // User with both matching claims → sees only AND-matched docs
  const { client } = await createUser('auth-multi@test.com', {
    claims: { orgId: 'auburn', region: 'south' },
  })

  const docs = await client.collection('auth_multi_filter').get()
  assert(docs.length === 1, `AND filter returns 1 doc (got ${docs.length})`)
  assert(docs[0]?.data?.orgId === 'auburn' && docs[0]?.data?.region === 'south', 'AND filter matches correct doc')

  await resetRules()
}

// ── 7. Missing/empty claims → 403 ───────────────────────────

async function testMissingClaims() {
  console.log('\n== Missing/Empty Claims ==')

  await setRules({
    default: 'public',
    collections: {
      auth_missing_claim: { access: 'authenticated', filter: { orgId: 'claims.orgId' } },
    },
  })

  await admin.collection('auth_missing_claim').add({ orgId: 'auburn', val: 1 })

  // User with no claims at all → 403
  const { client: noClaims } = await createUser('auth-noclaim@test.com')
  try {
    await noClaims.collection('auth_missing_claim').get()
    assert(false, 'user with no claims should get 403')
  } catch {
    assert(true, 'user with missing claim gets 403')
  }

  // User with empty array claim → 403
  await setRules({
    default: 'public',
    collections: {
      auth_empty_arr: { access: 'authenticated', filter: { orgId: 'claims.orgIds' } },
    },
  })
  await admin.collection('auth_empty_arr').add({ orgId: 'auburn', val: 1 })

  const { client: emptyClaim } = await createUser('auth-emptyclaim@test.com', {
    claims: { orgIds: [] },
  })
  try {
    await emptyClaim.collection('auth_empty_arr').get()
    assert(false, 'user with empty array claim should get 403')
  } catch {
    assert(true, 'user with empty array claim gets 403')
  }

  await resetRules()
}

// ── 8. Filter enforcement on mutations ───────────────────────

async function testFilterEnforcementOnMutations() {
  console.log('\n== Filter Enforcement on Mutations ==')

  await setRules({
    default: 'public',
    collections: {
      auth_mutation_filter: { access: 'authenticated', filter: { orgId: 'claims.orgId' } },
    },
  })

  // Admin seeds docs
  const myDoc = await admin.collection('auth_mutation_filter').add({ orgId: 'auburn', val: 'mine' })
  const otherDoc = await admin.collection('auth_mutation_filter').add({ orgId: 'oxford', val: 'theirs' })

  const { client } = await createUser('auth-mutfilt@test.com', {
    claims: { orgId: 'auburn' },
  })

  // Can read own org's doc
  const mine = await client.collection('auth_mutation_filter').doc(myDoc.id).get()
  assert(mine !== null && mine.data.orgId === 'auburn', 'user can read matching doc')

  // Can't read other org's doc (404)
  const theirs = await client.collection('auth_mutation_filter').doc(otherDoc.id).get()
  assert(theirs === null, 'user gets null (404) for non-matching doc')

  // Can update own doc
  const updated = await client.collection('auth_mutation_filter').doc(myDoc.id).update({ val: 'updated' })
  assert(updated.data.val === 'updated', 'user can update matching doc')

  // Can't update other org's doc
  try {
    await client.collection('auth_mutation_filter').doc(otherDoc.id).update({ val: 'hacked' })
    assert(false, 'user should not update non-matching doc')
  } catch {
    assert(true, 'user blocked from updating non-matching doc')
  }

  // Can't delete other org's doc
  try {
    await client.collection('auth_mutation_filter').doc(otherDoc.id).delete()
    assert(false, 'user should not delete non-matching doc')
  } catch {
    assert(true, 'user blocked from deleting non-matching doc')
  }

  // Can create (POST) — filters don't block creates
  const created = await client.collection('auth_mutation_filter').add({ orgId: 'whatever', val: 'new' })
  assert(!!created.id, 'user can create docs (filters don\'t block POST)')

  // Can delete own doc
  await client.collection('auth_mutation_filter').doc(myDoc.id).delete()
  const gone = await client.collection('auth_mutation_filter').doc(myDoc.id).get()
  assert(gone === null, 'user can delete their own matching doc')

  await resetRules()
}

// ── 9. Admin-role user (role='admin') ────────────────────────

async function testAdminRoleUser() {
  console.log('\n== Admin-Role User ==')

  await setRules({
    default: 'public',
    collections: { auth_admin_only: 'admin' },
  })

  await admin.collection('auth_admin_only').add({ val: 'secret' })

  // User with role='admin' should access admin-level collections
  const { client: adminUser } = await createUser('auth-adminrole@test.com', { role: 'admin' })
  const docs = await adminUser.collection('auth_admin_only').get()
  assert(Array.isArray(docs) && docs.length >= 1, 'user with role=admin can read admin collection')

  // Can also write
  const created = await adminUser.collection('auth_admin_only').add({ val: 'admin-user-created' })
  assert(!!created.id, 'user with role=admin can write to admin collection')

  // Regular user still blocked
  const { client: regular } = await createUser('auth-nonadmin@test.com')
  try {
    await regular.collection('auth_admin_only').get()
    assert(false, 'regular user should be blocked from admin collection')
  } catch {
    assert(true, 'regular user gets 403 on admin collection')
  }

  await resetRules()
}

// ── 10. User management authorization ────────────────────────

async function testUserManagementAuth() {
  console.log('\n== User Management Authorization ==')

  const { client: regular, userId } = await createUser('auth-mgmt@test.com')

  // Non-admin → 401/403 on all user management endpoints
  const endpoints = [
    { path: '/auth/users', method: 'GET' },
    { path: `/auth/users/${userId}`, method: 'GET' },
    { path: `/auth/users/${userId}/role`, method: 'PUT', body: { role: 'hacker' } },
    { path: `/auth/users/${userId}/claims`, method: 'PUT', body: { evil: true } },
    { path: `/auth/users/${userId}/claims`, method: 'PATCH', body: { evil: true } },
  ]

  for (const ep of endpoints) {
    const token = (regular.auth as any)._getToken()
    const res = await fetch(`${URL}/api${ep.path}`, {
      method: ep.method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      ...(ep.body ? { body: JSON.stringify(ep.body) } : {}),
    })
    assert(
      res.status === 403,
      `non-admin ${ep.method} ${ep.path.replace(userId, ':id')} → ${res.status} (expected 403)`
    )
  }

  // Anonymous → 401
  const anonRes = await fetch(`${URL}/api/auth/users`)
  assert(anonRes.status === 401, 'anonymous GET /auth/users → 401')
}

// ── 11. Self-deletion guard ──────────────────────────────────

async function testSelfDeletionGuard() {
  console.log('\n== Self-Deletion Guard ==')

  // Create an admin-role user
  const { client: adminUser, userId } = await createUser('auth-selfdelete@test.com', { role: 'admin' })
  const token = (adminUser.auth as any)._getToken()

  // Try to delete themselves
  const res = await fetch(`${URL}/api/auth/users/${userId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
  assert(res.status === 400, 'admin-role user cannot delete themselves')
  const body = await res.json()
  assert(body.error?.includes('own account'), 'error message mentions own account')
}

// ── 12. Internal table protection ────────────────────────────

async function testInternalTableProtection() {
  console.log('\n== Internal Table Protection ==')

  // Authenticated user can't access _ezbase_ collections
  const { client } = await createUser('auth-internal@test.com')
  try {
    await client.collection('_ezbase_config').get()
    assert(false, 'authenticated user should be blocked from _ezbase_ collection')
  } catch {
    assert(true, 'authenticated user gets 403 on _ezbase_ collection')
  }

  // Anonymous gets 401
  const anonRes = await fetch(`${URL}/api/collections/_ezbase_config`)
  assert(anonRes.status === 401, 'anonymous gets 401 on _ezbase_ collection')
}

// ── 13. Bucket permissions ───────────────────────────────────

async function testBucketPermissions() {
  console.log('\n== Bucket Permissions ==')

  await setRules({
    default: 'public',
    buckets: {
      auth_public_bucket: 'public',
      auth_authed_bucket: 'authenticated',
      auth_admin_bucket: 'admin',
      auth_role_bucket: 'role:uploader',
      auth_owner_bucket: 'owner',
    },
  })

  const makeFile = (name: string) => {
    const formData = new FormData()
    formData.append('file', new Blob([`content-${name}`], { type: 'text/plain' }), `${name}.txt`)
    return formData
  }

  // Public bucket — anonymous can upload and download
  const pubUpload = await fetch(`${URL}/api/storage/auth_public_bucket`, {
    method: 'POST',
    body: makeFile('pub'),
  })
  assert(pubUpload.status === 201, 'public bucket: anonymous upload succeeds')
  const pubMeta = await pubUpload.json()

  const pubDownload = await fetch(`${URL}/api/storage/${pubMeta.path}`)
  assert(pubDownload.ok, 'public bucket: anonymous download succeeds')

  // Authenticated bucket — anonymous blocked
  const anonAuthUpload = await fetch(`${URL}/api/storage/auth_authed_bucket`, {
    method: 'POST',
    body: makeFile('anon-fail'),
  })
  assert(anonAuthUpload.status === 401, 'authenticated bucket: anonymous upload → 401')

  // Authenticated bucket — user can upload
  const { client: authUser } = await createUser('auth-bucket@test.com')
  const token = (authUser.auth as any)._getToken()
  const authUpload = await fetch(`${URL}/api/storage/auth_authed_bucket`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: makeFile('user-ok'),
  })
  assert(authUpload.status === 201, 'authenticated bucket: user upload succeeds')

  // Admin bucket — user blocked
  const adminBucketRes = await fetch(`${URL}/api/storage/auth_admin_bucket`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: makeFile('admin-fail'),
  })
  assert(adminBucketRes.status === 403, 'admin bucket: authenticated user → 403')

  // Admin bucket — admin key can upload
  const adminBucketOk = await apiFetch('/storage/auth_admin_bucket', {
    method: 'POST',
    body: makeFile('admin-ok'),
  })
  assert(adminBucketOk.status === 201, 'admin bucket: admin upload succeeds')

  // Role bucket — wrong role blocked
  const roleBucketFail = await fetch(`${URL}/api/storage/auth_role_bucket`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: makeFile('role-fail'),
  })
  assert(roleBucketFail.status === 403, 'role bucket: user without matching role → 403')

  // Role bucket — correct role succeeds
  const { client: uploaderUser } = await createUser('auth-uploader@test.com', { role: 'uploader' })
  const uploaderToken = (uploaderUser.auth as any)._getToken()
  const roleBucketOk = await fetch(`${URL}/api/storage/auth_role_bucket`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${uploaderToken}` },
    body: makeFile('role-ok'),
  })
  assert(roleBucketOk.status === 201, 'role bucket: user with matching role can upload')

  // Owner bucket — user A uploads, user B can't download
  const { client: ownerA } = await createUser('auth-owner-bucket-a@test.com')
  const tokenA = (ownerA.auth as any)._getToken()
  const ownerUpload = await fetch(`${URL}/api/storage/auth_owner_bucket/private.txt`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenA}` },
    body: makeFile('owner-private'),
  })
  assert(ownerUpload.status === 201, 'owner bucket: user A upload succeeds')

  // User A can download their own file
  const ownerDownload = await fetch(`${URL}/api/storage/auth_owner_bucket/private.txt`, {
    headers: { Authorization: `Bearer ${tokenA}` },
  })
  assert(ownerDownload.ok, 'owner bucket: user A can download their own file')

  // User B can't download user A's file
  const { client: ownerB } = await createUser('auth-owner-bucket-b@test.com')
  const tokenB = (ownerB.auth as any)._getToken()
  const crossDownload = await fetch(`${URL}/api/storage/auth_owner_bucket/private.txt`, {
    headers: { Authorization: `Bearer ${tokenB}` },
  })
  assert(crossDownload.status === 403, 'owner bucket: user B can\'t download user A\'s file')

  await resetRules()
}

// ── 14. Nested claim paths ───────────────────────────────────

async function testNestedClaimPaths() {
  console.log('\n== Nested Claim Paths ==')

  await setRules({
    default: 'public',
    collections: {
      auth_nested_claim: { access: 'authenticated', filter: { teamId: 'claims.org.teamId' } },
    },
  })

  await admin.collection('auth_nested_claim').add({ teamId: 'alpha', val: 1 })
  await admin.collection('auth_nested_claim').add({ teamId: 'beta', val: 2 })

  const { client } = await createUser('auth-nested@test.com', {
    claims: { org: { teamId: 'alpha', name: 'Alpha Corp' } },
  })

  const docs = await client.collection('auth_nested_claim').get()
  assert(docs.length === 1, `nested claim filter returns 1 doc (got ${docs.length})`)
  assert(docs[0]?.data?.teamId === 'alpha', 'nested claim matches correct doc')

  await resetRules()
}

// ── 15. Session lifecycle: claims update → re-signin ─────────

async function testSessionLifecycle() {
  console.log('\n== Session Lifecycle ==')

  await setRules({
    default: 'public',
    collections: {
      auth_lifecycle: { access: 'authenticated', filter: { orgId: 'claims.orgId' } },
    },
  })

  await admin.collection('auth_lifecycle').add({ orgId: 'auburn', val: 1 })
  await admin.collection('auth_lifecycle').add({ orgId: 'oxford', val: 2 })

  // Create user with orgId=auburn
  const { client, userId } = await createUser('auth-lifecycle@test.com', {
    claims: { orgId: 'auburn' },
  })

  // Sees auburn doc
  let docs = await client.collection('auth_lifecycle').get()
  assert(docs.length === 1 && docs[0].data.orgId === 'auburn', 'initially sees auburn doc')

  // Admin changes claims to oxford
  await admin.auth.setClaims(userId, { orgId: 'oxford' })

  // Re-signin to pick up new claims
  await client.auth.signOut()
  await client.auth.signIn({ email: 'auth-lifecycle@test.com', password: 'testpass123' })

  // Now sees oxford doc
  docs = await client.collection('auth_lifecycle').get()
  assert(docs.length === 1 && docs[0].data.orgId === 'oxford', 'after claims update + re-signin, sees oxford doc')

  await resetRules()
}

// ── 16. Read/write split with filters ────────────────────────

async function testReadWriteSplitWithFilters() {
  console.log('\n== Read/Write Split + Filters ==')

  await setRules({
    default: 'public',
    collections: {
      auth_rw_complex: {
        read: { access: 'authenticated', filter: { orgId: 'claims.orgId' } },
        write: 'role:editor',
      },
    },
  })

  await admin.collection('auth_rw_complex').add({ orgId: 'auburn', val: 1 })
  await admin.collection('auth_rw_complex').add({ orgId: 'oxford', val: 2 })

  // Authenticated reader — can read filtered, can't write
  const { client: reader } = await createUser('auth-rw-reader@test.com', {
    claims: { orgId: 'auburn' },
  })
  const readDocs = await reader.collection('auth_rw_complex').get()
  assert(readDocs.length === 1, 'reader sees filtered docs')

  try {
    await reader.collection('auth_rw_complex').add({ orgId: 'auburn', val: 3 })
    assert(false, 'reader should not be able to write')
  } catch {
    assert(true, 'reader blocked from writing (write=role:editor)')
  }

  // Editor with correct role — can write
  const { client: editor } = await createUser('auth-rw-editor@test.com', {
    role: 'editor',
    claims: { orgId: 'auburn' },
  })
  const created = await editor.collection('auth_rw_complex').add({ orgId: 'auburn', val: 3 })
  assert(!!created.id, 'editor with role:editor can write')

  // Editor can also read (filtered)
  const editorDocs = await editor.collection('auth_rw_complex').get()
  assert(editorDocs.length >= 2, 'editor sees filtered docs on read')
  assert(editorDocs.every((d: any) => d.data.orgId === 'auburn'), 'editor only sees auburn docs')

  await resetRules()
}

// ── 17. Default fallback with read/write object ──────────────

async function testDefaultFallback() {
  console.log('\n== Default Fallback ==')

  // Default with read/write split — unlisted collections should use it
  await setRules({
    default: { read: 'public', write: 'admin' },
  })

  // Seed as admin
  await admin.collection('auth_fallback_col').add({ val: 'test' })

  // Anonymous can read (default read=public)
  const anonGet = await fetch(`${URL}/api/collections/auth_fallback_col`)
  assert(anonGet.ok, 'default fallback: anonymous can read (read=public)')

  // Anonymous can't write (default write=admin)
  const anonPost = await fetch(`${URL}/api/collections/auth_fallback_col`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ val: 'nope' }),
  })
  assert(anonPost.status === 401, 'default fallback: anonymous POST → 401 (write=admin)')

  // Authenticated user can't write either (write=admin)
  const { client: user } = await createUser('auth-fallback@test.com')
  try {
    await user.collection('auth_fallback_col').add({ val: 'nope' })
    assert(false, 'authenticated user should be blocked from writing (write=admin)')
  } catch {
    assert(true, 'default fallback: authenticated user blocked from writing (write=admin)')
  }

  await resetRules()
}

// ── 18. SSE with auth + filters ──────────────────────────────

async function testSSEWithAuthFilters() {
  console.log('\n== SSE with Auth + Filters ==')

  await setRules({
    default: 'public',
    collections: {
      auth_sse_filter: { access: 'authenticated', filter: { orgId: 'claims.orgId' } },
    },
  })

  // Seed data
  await admin.collection('auth_sse_filter').add({ orgId: 'auburn', val: 'initial' })
  await admin.collection('auth_sse_filter').add({ orgId: 'oxford', val: 'other' })

  const { client } = await createUser('auth-sse@test.com', {
    claims: { orgId: 'auburn' },
  })

  // SSE subscription should only deliver filtered docs
  const sseResult = await new Promise<boolean>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('SSE auth filter timeout')), 15000)
    let gotInitial = false
    const unsub = client.collection('auth_sse_filter').onSnapshot(
      (docs: any[]) => {
        if (!gotInitial) {
          gotInitial = true
          // Initial snapshot should only have auburn docs
          if (docs.length === 1 && docs[0].data.orgId === 'auburn') {
            // Add another auburn doc to test live updates
            admin.collection('auth_sse_filter').add({ orgId: 'auburn', val: 'live' })
          } else {
            clearTimeout(timeout)
            unsub()
            resolve(false)
          }
        } else if (docs.length === 2 && docs.every((d: any) => d.data.orgId === 'auburn')) {
          clearTimeout(timeout)
          unsub()
          resolve(true)
        }
      },
      () => { clearTimeout(timeout); reject(new Error('SSE error')) }
    )
  })
  assert(sseResult, 'SSE with auth filters: only delivers filtered docs + live updates')

  await resetRules()
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  console.log('ezbase Auth & Authorization test suite')
  console.log(`URL: ${URL}`)
  console.log(`Admin key: ${ADMIN_KEY.slice(0, 8)}...`)

  console.log('\nWaiting for ezbase...')
  await waitForHealthy()
  console.log('Ready!')

  await testIdentity()
  await testProviders()
  await testRoleBasedAccess()
  await testOwnerPermission()
  await testArrayClaimFilters()
  await testMultipleFilterKeys()
  await testMissingClaims()
  await testFilterEnforcementOnMutations()
  await testAdminRoleUser()
  await testUserManagementAuth()
  await testSelfDeletionGuard()
  await testInternalTableProtection()
  await testBucketPermissions()
  await testNestedClaimPaths()
  await testSessionLifecycle()
  await testReadWriteSplitWithFilters()
  await testDefaultFallback()
  await testSSEWithAuthFilters()

  console.log(`\n${'='.repeat(50)}`)
  console.log(`Results: ${passed} passed, ${failed} failed`)
  if (failures.length > 0) {
    console.log('\nFailures:')
    for (const f of failures) console.log(`  - ${f}`)
  }
  console.log('')
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
