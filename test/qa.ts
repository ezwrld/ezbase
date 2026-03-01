/**
 * ezbase QA suite — comprehensive end-to-end tests against a running instance.
 *
 * Covers: health, CRUD, queries, multi-db, auth, rules, storage, SSE, read/write permissions.
 *
 * Usage:
 *   bun run test/qa.ts                        # uses defaults
 *   URL=http://localhost:7003 ADMIN_KEY=... bun run test/qa.ts
 *
 * Expects: a fresh ezbase instance (ez down --nuke && ez up, or test docker-compose).
 */

import { EzBase } from '../sdk/src/index.js'

const URL = process.env.URL || 'http://localhost:7003'
const ADMIN_KEY = process.env.ADMIN_KEY || 'test-admin-key'

let passed = 0
let failed = 0
let skipped = 0
const failures: string[] = []

function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`  \u2713 ${msg}`)
    passed++
  } else {
    console.error(`  \u2717 ${msg}`)
    failed++
    failures.push(msg)
  }
}

function skip(msg: string) {
  console.log(`  - SKIP: ${msg}`)
  skipped++
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

// ── Test sections ────────────────────────────────────────────

async function testHealth() {
  console.log('\n== Health ==')
  const res = await fetch(`${URL}/api/health`)
  const body = await res.json()
  assert(res.ok && body.status === 'ok', 'GET /health returns ok')
}

async function testCRUD() {
  console.log('\n== CRUD ==')
  const admin = new EzBase({ url: URL, adminKey: ADMIN_KEY })

  // Create
  const doc = await admin.collection('qa_crud').add({ title: 'Hello', n: 1 })
  assert(!!doc.id && doc.data.title === 'Hello', 'add() creates document')

  // Read
  const fetched = await admin.collection('qa_crud').doc(doc.id).get()
  assert(fetched !== null && fetched!.id === doc.id, 'doc().get() reads document')

  // Update (PATCH)
  const updated = await admin.collection('qa_crud').doc(doc.id).update({ n: 2 })
  assert(updated.data.n === 2 && updated.data.title === 'Hello', 'update() merges fields')

  // Set (PUT)
  const replaced = await admin.collection('qa_crud').doc(doc.id).set({ title: 'Replaced' } as any)
  assert(replaced.data.title === 'Replaced', 'set() replaces data')

  // List
  const all = await admin.collection('qa_crud').get()
  assert(all.length >= 1, 'collection().get() lists documents')

  // Delete
  await admin.collection('qa_crud').doc(doc.id).delete()
  const gone = await admin.collection('qa_crud').doc(doc.id).get()
  assert(gone === null, 'delete() removes document')

  // Get nonexistent
  const nope = await admin.collection('qa_crud').doc('nonexistent-id').get()
  assert(nope === null, 'get() returns null for missing doc')
}

async function testQueries() {
  console.log('\n== Queries ==')
  const admin = new EzBase({ url: URL, adminKey: ADMIN_KEY })

  for (let i = 1; i <= 5; i++) {
    await admin.collection('qa_query').add({ name: `item-${i}`, score: i * 10 })
  }

  const filtered = await admin.collection('qa_query').where('score', '>', 20).get()
  assert(filtered.length === 3, `where(score > 20) = 3 docs (got ${filtered.length})`)

  const limited = await admin.collection('qa_query').limit(2).get()
  assert(limited.length === 2, 'limit(2) returns 2 docs')

  const ordered = await admin.collection('qa_query').orderBy('score', 'asc').limit(1).get()
  assert(ordered[0]?.data?.score === 10, 'orderBy(score, asc) returns lowest first')

  const chained = await admin.collection('qa_query')
    .where('score', '>=', 20)
    .orderBy('score', 'desc')
    .limit(2)
    .get()
  assert(chained.length === 2 && chained[0]?.data?.score === 50, 'chained query works')

  // Compound where
  const compound = await admin.collection('qa_query')
    .where('score', '>=', 20)
    .where('score', '<=', 40)
    .get()
  assert(compound.length === 3, `compound where (20-40) = 3 docs (got ${compound.length})`)
}

async function testMultiDb() {
  console.log('\n== Multi-Database ==')
  const admin = new EzBase({ url: URL, adminKey: ADMIN_KEY })

  // Create in named databases
  const docA = await admin.database('qa_alpha').collection('items').add({ from: 'alpha' })
  const docB = await admin.database('qa_beta').collection('items').add({ from: 'beta' })
  assert(!!docA.id && docA.data.from === 'alpha', 'write to qa_alpha works')
  assert(!!docB.id && docB.data.from === 'beta', 'write to qa_beta works')

  // Isolation
  const alphaItems = await admin.database('qa_alpha').collection('items').get()
  const betaItems = await admin.database('qa_beta').collection('items').get()
  assert(alphaItems.every(d => d.data.from === 'alpha'), 'qa_alpha only has alpha docs')
  assert(betaItems.every(d => d.data.from === 'beta'), 'qa_beta only has beta docs')

  // List databases
  const dbs = await admin.listDatabases()
  assert(dbs.includes('default'), 'listDatabases includes default')
  assert(dbs.includes('qa_alpha'), 'listDatabases includes qa_alpha')
  assert(dbs.includes('qa_beta'), 'listDatabases includes qa_beta')

  // List collections in named db
  const cols = await admin.database('qa_alpha').listCollections()
  assert(cols.includes('items'), 'listCollections for qa_alpha includes items')

  // Delete database
  const delRes = await apiFetch('/db/qa_beta', { method: 'DELETE' })
  assert(delRes.ok, 'DELETE /db/qa_beta succeeds')

  const dbsAfter = await admin.listDatabases()
  assert(!dbsAfter.includes('qa_beta'), 'qa_beta gone after delete')

  // Cannot delete default
  const defRes = await apiFetch('/db/default', { method: 'DELETE' })
  assert(defRes.status === 400, 'cannot delete default database')
}

async function testAuth() {
  console.log('\n== Auth ==')
  const client = new EzBase({ url: URL })

  // Sign up
  const { token, user } = await client.auth.signUp({
    email: 'qa-user@example.com',
    password: 'testpass123',
  })
  assert(typeof token === 'string' && token.length > 0, 'signUp returns token')
  assert(user.email === 'qa-user@example.com', 'signUp returns correct email')
  assert(client.auth.currentUser?.email === 'qa-user@example.com', 'currentUser set after signUp')

  // Sign out
  await client.auth.signOut()
  assert(client.auth.currentUser === null, 'currentUser null after signOut')

  // Sign in
  const { token: t2 } = await client.auth.signIn({
    email: 'qa-user@example.com',
    password: 'testpass123',
  })
  assert(typeof t2 === 'string' && t2.length > 0, 'signIn returns token')

  // Duplicate signup fails
  try {
    await new EzBase({ url: URL }).auth.signUp({
      email: 'qa-user@example.com',
      password: 'testpass123',
    })
    assert(false, 'duplicate signUp should throw')
  } catch {
    assert(true, 'duplicate signUp rejected')
  }

  // Bad password fails
  try {
    await new EzBase({ url: URL }).auth.signIn({
      email: 'qa-user@example.com',
      password: 'wrongwrong',
    })
    assert(false, 'bad password should throw')
  } catch {
    assert(true, 'bad password rejected')
  }

  // onAuthStateChanged
  let stateChanged = false
  const unsub = client.auth.onAuthStateChanged(() => { stateChanged = true })
  await client.auth.signOut()
  assert(stateChanged, 'onAuthStateChanged fires on signOut')
  unsub()
}

async function testUserManagement() {
  console.log('\n== User Management ==')
  const admin = new EzBase({ url: URL, adminKey: ADMIN_KEY })

  // Create a user to manage
  const client = new EzBase({ url: URL })
  const { user } = await client.auth.signUp({
    email: 'qa-managed@example.com',
    password: 'testpass123',
  })

  // List users
  const users = await admin.auth.listUsers({ limit: 50 })
  assert(users.some((u: any) => u.email === 'qa-managed@example.com'), 'listUsers includes created user')

  // Get user
  const fetched = await admin.auth.getUser(user.id)
  assert(fetched.email === 'qa-managed@example.com', 'getUser returns correct user')

  // Set role
  await admin.auth.setRole(user.id, 'mover')
  const afterRole = await admin.auth.getUser(user.id)
  assert(afterRole.role === 'mover', 'setRole changes role')

  // Set claims (replace)
  await admin.auth.setClaims(user.id, { orgId: 'auburn', tier: 'pro' })
  const afterClaims = await admin.auth.getUser(user.id)
  assert(afterClaims.claims.orgId === 'auburn' && afterClaims.claims.tier === 'pro', 'setClaims replaces claims')

  // Merge claims
  await admin.auth.mergeClaims(user.id, { region: 'southeast', tier: null })
  const afterMerge = await admin.auth.getUser(user.id)
  assert(afterMerge.claims.region === 'southeast', 'mergeClaims adds new key')
  assert(afterMerge.claims.tier === undefined, 'mergeClaims null deletes key')
  assert(afterMerge.claims.orgId === 'auburn', 'mergeClaims preserves existing keys')

  // Delete user
  await admin.auth.deleteUser(user.id)
  try {
    await admin.auth.getUser(user.id)
    assert(false, 'getUser should 404 after delete')
  } catch {
    assert(true, 'user gone after deleteUser')
  }
}

async function testRules() {
  console.log('\n== Rules ==')

  // Get default rules
  const getRes = await apiFetch('/rules')
  const { rules, readonly: ro } = await getRes.json()
  assert(getRes.ok, 'GET /rules succeeds')
  assert(typeof rules.default === 'string', 'rules has default key')

  // Set rules
  const newRules = {
    default: 'public',
    collections: {
      qa_secret: 'authenticated',
      qa_admin_only: 'admin',
    },
  }
  const putRes = await apiFetch('/rules', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_KEY}` },
    body: JSON.stringify(newRules),
  })
  assert(putRes.ok, 'PUT /rules succeeds')

  // Verify: anonymous can't access authenticated collection
  const anonRes = await fetch(`${URL}/api/collections/qa_secret`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: 'nope' }),
  })
  assert(anonRes.status === 401, 'anonymous gets 401 on authenticated collection')

  // Verify: admin can access admin collection
  const adminRes = await apiFetch('/collections/qa_admin_only', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_KEY}` },
    body: JSON.stringify({ data: 'yes' }),
  })
  assert(adminRes.status === 201, 'admin can write to admin collection')

  // Invalid rules rejected
  const badRes = await apiFetch('/rules', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_KEY}` },
    body: JSON.stringify({ default: 'invalid_level' }),
  })
  assert(badRes.status === 400, 'invalid rules rejected with 400')

  // Non-admin gets 401
  const noAuthRes = await fetch(`${URL}/api/rules`)
  assert(noAuthRes.status === 401, 'GET /rules without auth returns 401')

  // Restore public default
  await apiFetch('/rules', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_KEY}` },
    body: JSON.stringify({ default: 'public' }),
  })
}

async function testClaimFilters() {
  console.log('\n== Claim-Based Filters ==')
  const admin = new EzBase({ url: URL, adminKey: ADMIN_KEY })

  // Set up rules with claim filter
  await apiFetch('/rules', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_KEY}` },
    body: JSON.stringify({
      default: 'public',
      collections: {
        qa_filtered: { access: 'authenticated', filter: { orgId: 'claims.orgId' } },
      },
    }),
  })

  // Create docs with different orgIds
  await admin.collection('qa_filtered').add({ orgId: 'auburn', item: 'a1' })
  await admin.collection('qa_filtered').add({ orgId: 'auburn', item: 'a2' })
  await admin.collection('qa_filtered').add({ orgId: 'oxford', item: 'o1' })

  // Create user with orgId claim
  const client = new EzBase({ url: URL })
  const { user } = await client.auth.signUp({
    email: 'qa-filter@example.com',
    password: 'testpass123',
  })
  await admin.auth.setClaims(user.id, { orgId: 'auburn' })

  // Re-sign in to pick up claims
  await client.auth.signOut()
  await client.auth.signIn({ email: 'qa-filter@example.com', password: 'testpass123' })

  // Query — should only see auburn docs
  const docs = await client.collection('qa_filtered').get()
  assert(docs.length === 2, `filtered query returns 2 auburn docs (got ${docs.length})`)
  assert(docs.every(d => d.data.orgId === 'auburn'), 'all returned docs are auburn')

  // Admin sees all
  const allDocs = await admin.collection('qa_filtered').get()
  assert(allDocs.length === 3, `admin sees all 3 docs (got ${allDocs.length})`)

  // Restore rules
  await apiFetch('/rules', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_KEY}` },
    body: JSON.stringify({ default: 'public' }),
  })
}

async function testStorage() {
  console.log('\n== Storage ==')

  // Upload a file
  const formData = new FormData()
  formData.append('file', new Blob(['hello world'], { type: 'text/plain' }), 'test.txt')

  const uploadRes = await apiFetch('/storage/qa_bucket', {
    method: 'POST',
    body: formData,
  })
  assert(uploadRes.status === 201, 'file upload returns 201')
  const meta = await uploadRes.json()
  assert(meta.bucket === 'qa_bucket', 'upload returns correct bucket')
  assert(meta.size === 11, 'upload returns correct size')

  // Upload to specific path
  const formData2 = new FormData()
  formData2.append('file', new Blob(['specific path'], { type: 'text/plain' }), 'named.txt')

  const upload2Res = await apiFetch('/storage/qa_bucket/subdir/named.txt', {
    method: 'POST',
    body: formData2,
  })
  assert(upload2Res.status === 201, 'specific path upload returns 201')

  // List buckets
  const bucketsRes = await apiFetch('/storage')
  const buckets = await bucketsRes.json()
  assert(Array.isArray(buckets) && buckets.includes('qa_bucket'), 'list buckets includes qa_bucket')

  // List files in bucket
  const filesRes = await apiFetch('/storage/qa_bucket')
  const files = await filesRes.json()
  assert(Array.isArray(files) && files.length >= 2, 'list files returns uploaded files')

  // Download
  const downloadRes = await apiFetch(`/storage/${meta.path}`)
  const text = await downloadRes.text()
  assert(text === 'hello world', 'download returns file content')

  // HEAD
  const headRes = await fetch(`${URL}/api/storage/${meta.path}`, {
    method: 'HEAD',
    headers: { Authorization: `Bearer ${ADMIN_KEY}` },
  })
  assert(headRes.ok, 'HEAD returns ok')
  assert(headRes.headers.get('Content-Type')?.startsWith('text/plain'), 'HEAD returns correct content-type')

  // Delete
  const deleteRes = await apiFetch(`/storage/${meta.path}`, { method: 'DELETE' })
  assert(deleteRes.ok, 'file delete succeeds')

  const gone = await apiFetch(`/storage/${meta.path}`)
  assert(gone.status === 404, 'deleted file returns 404')
}

async function testSSE() {
  console.log('\n== SSE Real-Time ==')
  const admin = new EzBase({ url: URL, adminKey: ADMIN_KEY })

  // Collection-level SSE
  const colResult = await new Promise<boolean>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Collection SSE timeout')), 15000)
    let gotInitial = false
    const unsub = admin.collection('qa_sse_col').onSnapshot(
      (docs) => {
        if (!gotInitial) {
          gotInitial = true
          admin.collection('qa_sse_col').add({ live: true })
        } else if (docs.length > 0 && docs.some(d => d.data.live === true)) {
          clearTimeout(timeout)
          unsub()
          resolve(true)
        }
      },
      (err) => { clearTimeout(timeout); reject(err) }
    )
  })
  assert(colResult, 'collection onSnapshot delivers created doc')

  // Doc-level SSE
  const seed = await admin.collection('qa_sse_doc').add({ val: 1 })
  const docResult = await new Promise<boolean>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Doc SSE timeout')), 15000)
    let gotInitial = false
    const unsub = admin.collection('qa_sse_doc').doc(seed.id).onSnapshot(
      (doc) => {
        if (!gotInitial) {
          gotInitial = true
          admin.collection('qa_sse_doc').doc(seed.id).update({ val: 2 })
        } else if (doc && doc.data.val === 2) {
          clearTimeout(timeout)
          unsub()
          resolve(true)
        }
      },
      (err) => { clearTimeout(timeout); reject(err) }
    )
  })
  assert(docResult, 'doc onSnapshot delivers update')
}

async function testReadWritePermissions() {
  console.log('\n== Read/Write Permissions ==')
  const admin = new EzBase({ url: URL, adminKey: ADMIN_KEY })

  // Test 1: Collection with read=public, write=authenticated
  await apiFetch('/rules', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_KEY}` },
    body: JSON.stringify({
      default: 'public',
      collections: {
        qa_rw_split: { read: 'public', write: 'authenticated' },
      },
    }),
  })

  // Seed a doc as admin
  await admin.collection('qa_rw_split').add({ val: 'seeded' })

  // Anonymous GET should succeed (read=public)
  const anonGet = await fetch(`${URL}/api/collections/qa_rw_split`)
  assert(anonGet.ok, 'read/write: anonymous GET succeeds (read=public)')

  // Anonymous POST should fail (write=authenticated)
  const anonPost = await fetch(`${URL}/api/collections/qa_rw_split`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ val: 'nope' }),
  })
  assert(anonPost.status === 401, 'read/write: anonymous POST gets 401 (write=authenticated)')

  // Authenticated POST should succeed
  const client = new EzBase({ url: URL })
  await client.auth.signUp({ email: 'qa-rw@example.com', password: 'testpass123' })
  const doc = await client.collection('qa_rw_split').add({ val: 'user-created' })
  assert(!!doc.id, 'read/write: authenticated POST succeeds (write=authenticated)')

  // Test 2: Default as { read: public, write: authenticated }
  await apiFetch('/rules', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_KEY}` },
    body: JSON.stringify({
      default: { read: 'public', write: 'authenticated' },
    }),
  })

  // Seed doc in a new collection (will use default)
  await admin.collection('qa_rw_default').add({ val: 'seeded' })

  const anonGetDefault = await fetch(`${URL}/api/collections/qa_rw_default`)
  assert(anonGetDefault.ok, 'read/write default: anonymous GET succeeds')

  const anonPostDefault = await fetch(`${URL}/api/collections/qa_rw_default`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ val: 'nope' }),
  })
  assert(anonPostDefault.status === 401, 'read/write default: anonymous POST gets 401')

  // Test 3: Shorthand — string level applies to both read and write
  await apiFetch('/rules', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_KEY}` },
    body: JSON.stringify({
      default: 'public',
      collections: {
        qa_rw_shorthand: 'authenticated',
      },
    }),
  })

  const anonGetShorthand = await fetch(`${URL}/api/collections/qa_rw_shorthand`)
  assert(anonGetShorthand.status === 401, 'shorthand: string authenticated blocks anonymous GET')

  const anonPostShorthand = await fetch(`${URL}/api/collections/qa_rw_shorthand`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ val: 'nope' }),
  })
  assert(anonPostShorthand.status === 401, 'shorthand: string authenticated blocks anonymous POST')

  // Test 4: Filter on read + admin-only write
  await apiFetch('/rules', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_KEY}` },
    body: JSON.stringify({
      default: 'public',
      collections: {
        qa_rw_filter: {
          read: { access: 'authenticated', filter: { orgId: 'claims.orgId' } },
          write: 'admin',
        },
      },
    }),
  })

  // Seed docs
  await admin.collection('qa_rw_filter').add({ orgId: 'acme', item: 'a1' })
  await admin.collection('qa_rw_filter').add({ orgId: 'acme', item: 'a2' })
  await admin.collection('qa_rw_filter').add({ orgId: 'other', item: 'o1' })

  // Create user with claim
  const filterClient = new EzBase({ url: URL })
  const { user: filterUser } = await filterClient.auth.signUp({
    email: 'qa-rw-filter@example.com',
    password: 'testpass123',
  })
  await admin.auth.setClaims(filterUser.id, { orgId: 'acme' })

  // Re-sign in to pick up claims
  await filterClient.auth.signOut()
  await filterClient.auth.signIn({ email: 'qa-rw-filter@example.com', password: 'testpass123' })

  // Read — should see only acme docs
  const filtered = await filterClient.collection('qa_rw_filter').get()
  assert(filtered.length === 2, `read/write filter: user sees 2 acme docs (got ${filtered.length})`)
  assert(filtered.every(d => d.data.orgId === 'acme'), 'read/write filter: all docs are acme')

  // Write — authenticated user should be blocked (write=admin)
  try {
    await filterClient.collection('qa_rw_filter').add({ orgId: 'acme', item: 'blocked' })
    assert(false, 'read/write filter: authenticated user should not be able to write (write=admin)')
  } catch {
    assert(true, 'read/write filter: authenticated user blocked from writing (write=admin)')
  }

  // Test 5: read/write where only write is specified — read falls back to default
  await apiFetch('/rules', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_KEY}` },
    body: JSON.stringify({
      default: 'public',
      collections: {
        qa_rw_writeonly: { write: 'admin' },
      },
    }),
  })

  await admin.collection('qa_rw_writeonly').add({ val: 'test' })

  const anonGetWriteonly = await fetch(`${URL}/api/collections/qa_rw_writeonly`)
  assert(anonGetWriteonly.ok, 'read/write fallback: read falls back to default (public)')

  const anonPostWriteonly = await fetch(`${URL}/api/collections/qa_rw_writeonly`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ val: 'nope' }),
  })
  assert(anonPostWriteonly.status === 401, 'read/write fallback: write=admin blocks anonymous')

  // Restore rules
  await apiFetch('/rules', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_KEY}` },
    body: JSON.stringify({ default: 'public' }),
  })
}

async function testRotationRemoved() {
  console.log('\n== Key Rotation Removed ==')

  // Rotation endpoint should no longer exist
  const rotateRes = await apiFetch('/admin/rotate-key', { method: 'POST' })
  assert(rotateRes.status === 404, 'POST /admin/rotate-key returns 404 (removed)')
}

async function testCollectionValidation() {
  console.log('\n== Collection Name Validation ==')
  const admin = new EzBase({ url: URL, adminKey: ADMIN_KEY })

  const reserved = ['user', 'session', 'account', 'verification']
  for (const name of reserved) {
    try {
      await admin.collection(name).add({ test: true })
      assert(false, `reserved name '${name}' should be rejected`)
    } catch {
      assert(true, `reserved name '${name}' is rejected`)
    }
  }

  try {
    await admin.collection('_ezbase_foo').add({ test: true })
    assert(false, '_ezbase_ prefix should be rejected')
  } catch {
    assert(true, '_ezbase_ prefix is rejected')
  }
}

async function testPermissionLevels() {
  console.log('\n== Permission Levels ==')
  const admin = new EzBase({ url: URL, adminKey: ADMIN_KEY })

  // Set up various permission levels
  await apiFetch('/rules', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_KEY}` },
    body: JSON.stringify({
      default: 'public',
      collections: {
        qa_public: 'public',
        qa_auth: 'authenticated',
        qa_admin: 'admin',
      },
    }),
  })

  // Seed data
  await admin.collection('qa_public').add({ v: 1 })
  await admin.collection('qa_auth').add({ v: 1 })
  await admin.collection('qa_admin').add({ v: 1 })

  // Anonymous access
  const anonPublic = await fetch(`${URL}/api/collections/qa_public`)
  assert(anonPublic.ok, 'anonymous can read public collection')

  const anonAuth = await fetch(`${URL}/api/collections/qa_auth`)
  assert(anonAuth.status === 401, 'anonymous gets 401 on authenticated collection')

  const anonAdmin = await fetch(`${URL}/api/collections/qa_admin`)
  assert(anonAdmin.status === 401, 'anonymous gets 401 on admin collection')

  // Authenticated user
  const client = new EzBase({ url: URL })
  await client.auth.signUp({ email: 'qa-perms@example.com', password: 'testpass123' })

  const authAuth = await client.collection('qa_auth').get()
  assert(Array.isArray(authAuth), 'authenticated user can read authenticated collection')

  try {
    await client.collection('qa_admin').get()
    assert(false, 'authenticated user should be blocked from admin collection')
  } catch {
    assert(true, 'authenticated user gets 403 on admin collection')
  }

  // Restore rules
  await apiFetch('/rules', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_KEY}` },
    body: JSON.stringify({ default: 'public' }),
  })
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  console.log(`ezbase QA suite`)
  console.log(`URL: ${URL}`)
  console.log(`Admin key: ${ADMIN_KEY.slice(0, 8)}...`)

  console.log('\nWaiting for ezbase...')
  await waitForHealthy()
  console.log('Ready!')

  await testHealth()
  await testCRUD()
  await testQueries()
  await testMultiDb()
  await testAuth()
  await testUserManagement()
  await testRules()
  await testClaimFilters()
  await testPermissionLevels()
  await testReadWritePermissions()
  await testCollectionValidation()
  await testStorage()
  await testSSE()

  await testRotationRemoved()

  console.log(`\n${'='.repeat(50)}`)
  console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped`)
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
