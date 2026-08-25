/**
 * Backup roundtrip test — the disaster-recovery story, end to end:
 *   seed data → back up → DELETE THE DATABASE → restore → same data, same queries.
 *
 * Uses the SDK for everything a normal app would do, raw fetch for the backup API.
 * Runs entirely in a throwaway database. Safe against a stack with real data.
 *
 * Run: bun run test/backup-roundtrip.ts  (after stack is up)
 */

import { EzBase } from '../sdk/src/index.js'

const URL = process.env.URL || 'http://localhost:7003'
const ADMIN_KEY = process.env.ADMIN_KEY || 'test-admin-key'
const DB = 'bkroundtrip'

let passed = 0
let failed = 0

function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`  ✓ ${msg}`)
    passed++
  } else {
    console.error(`  ✗ ${msg}`)
    failed++
  }
}

const auth = { Authorization: `Bearer ${ADMIN_KEY}` }
const json = { ...auth, 'Content-Type': 'application/json' }

/** Deterministic stringify (sorted keys) for deep equality */
function canon(v: unknown): string {
  return JSON.stringify(v, function (this: any, key, value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)))
    }
    return value
  })
}

async function waitForHealthy(retries = 30) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${URL}/api/health`)
      if (res.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error('ezbase did not become healthy in time')
}

// Every doc in the db, as { "col/id": canonical-string }
async function snapshotAll(db: ReturnType<EzBase['database']>): Promise<Record<string, string>> {
  const snap: Record<string, string> = {}
  for (const col of await db.listCollections()) {
    for (const doc of await db.collection(col).get()) {
      snap[`${col}/${doc.id}`] = canon({ data: doc.data, created: doc.created, updated: doc.updated })
    }
  }
  return snap
}

function diffSnapshots(before: Record<string, string>, after: Record<string, string>): string[] {
  const problems: string[] = []
  for (const key of Object.keys(before)) {
    if (!(key in after)) problems.push(`missing after restore: ${key}`)
    else if (after[key] !== before[key]) problems.push(`changed after restore: ${key}`)
  }
  for (const key of Object.keys(after)) {
    if (!(key in before)) problems.push(`extra after restore: ${key}`)
  }
  return problems
}

async function main() {
  console.log('Waiting for ezbase to be healthy...')
  await waitForHealthy()
  console.log('ezbase is up!\n')

  const admin = new EzBase({ url: URL, adminKey: ADMIN_KEY })
  const db = admin.database(DB)

  // Fresh start in case a previous run died midway
  await fetch(`${URL}/api/db/${DB}`, { method: 'DELETE', headers: auth })

  // ── 1. Seed ─────────────────────────────────────────────────
  console.log('Seed')

  // Gnarly real-world JSON: nested, arrays, unicode, floats, nulls, empty things
  const dogs = [
    { name: 'Rex', age: 3, tags: ['good boy', 'fetch'], vet: { name: 'Dr. Wu', visits: [{ date: '2026-01-05', cost: 120.5 }] } },
    { name: '大きい犬 🐕', age: 0.5, tags: [], vet: null },
    { name: 'Nested', deep: { a: { b: { c: { d: [1, 2, { e: true }] } } } }, emptyObj: {}, emptyArr: [] },
    { name: 'Types', int: 42, float: 3.14159, neg: -7, bool: false, nil: null, big: 9007199254740991 },
    { name: 'Strings', quote: 'he said "hi"', newline: 'a\nb', slash: 'a\\b', long: 'x'.repeat(5000) },
  ]
  for (const d of dogs) await db.collection('dogs').add(d)

  // Enough events to cross the restore batch boundary (500)
  const EVENTS = 620
  for (let i = 0; i < EVENTS; i += 50) {
    await Promise.all(
      Array.from({ length: Math.min(50, EVENTS - i) }, (_, j) => i + j).map((n) =>
        db.collection('events').add({ n, kind: n % 3 === 0 ? 'click' : 'view', meta: { page: `/p/${n % 10}` } })
      )
    )
  }

  const before = await snapshotAll(db)
  assert(Object.keys(before).length === dogs.length + EVENTS, `seeded ${dogs.length + EVENTS} docs across 2 collections`)

  // Capture query results now — after restore, the same queries must return the same thing.
  // Docs sharing a created_at ms have arbitrary tie order, so compare where() as a set.
  const byId = (docs: { id: string }[]) => [...docs].sort((a, b) => (a.id < b.id ? -1 : 1))
  const queriesBefore = {
    clicks: canon(byId(await db.collection('events').where('kind', '==', 'click').get())),
    top: canon(await db.collection('events').orderBy('n', 'desc').limit(3).get()),
  }

  // ── 2. Back up ──────────────────────────────────────────────
  console.log('\nBackup')
  const createRes = await fetch(`${URL}/api/backups`, { method: 'POST', headers: json, body: JSON.stringify({ database: DB }) })
  const backup = await createRes.json()
  assert(createRes.status === 201 && !!backup.name, 'backup created')
  assert(backup.manifest?.stats?.databases?.[DB]?.collections?.events?.docCount === EVENTS, 'manifest doc count matches seed')

  // Keep a local copy too — we'll restore from it in round 2
  const dl = await fetch(`${URL}/api/backups/${backup.name}`, { headers: auth })
  const archive = await dl.arrayBuffer()
  assert(dl.ok && archive.byteLength > 0, `downloaded archive (${archive.byteLength} bytes)`)

  // ── 3. Disaster: delete the whole database ──────────────────
  console.log('\nDisaster')
  const del = await fetch(`${URL}/api/db/${DB}`, { method: 'DELETE', headers: auth })
  assert(del.ok, 'database deleted')
  assert((await db.listCollections()).length === 0, 'data is really gone')

  // ── 4. Restore from server-side backup ──────────────────────
  console.log('\nRestore (server-side backup)')
  const restoreRes = await fetch(`${URL}/api/backups/${backup.name}/restore`, { method: 'POST', headers: json, body: '{}' })
  const summary = await restoreRes.json()
  assert(restoreRes.ok, 'restore succeeded')
  assert(summary.documents?.[`${DB}/events`]?.restored === EVENTS, `all ${EVENTS} events restored`)
  assert(summary.documents?.[`${DB}/dogs`]?.restored === dogs.length, 'all dogs restored')

  // ── 5. Same data? ───────────────────────────────────────────
  console.log('\nVerify — every doc identical')
  const after = await snapshotAll(db)
  const problems = diffSnapshots(before, after)
  for (const p of problems.slice(0, 5)) console.error(`    ${p}`)
  assert(problems.length === 0, `all ${Object.keys(before).length} docs byte-identical (data + id + timestamps)`)

  // ── 6. Same queries? ────────────────────────────────────────
  console.log('\nVerify — queries work like before')
  {
    const clicks = await db.collection('events').where('kind', '==', 'click').get()
    assert(clicks.length === Math.ceil(EVENTS / 3), 'where() filter returns same count')
    assert(canon(byId(clicks)) === queriesBefore.clicks, 'where() returns identical result set')

    const top = await db.collection('events').orderBy('n', 'desc').limit(3).get()
    assert(canon(top) === queriesBefore.top, 'orderBy + limit returns identical result set')

    const rex = (await db.collection('dogs').where('name', '==', 'Rex').get())[0]
    assert(rex?.data.vet?.name === 'Dr. Wu', 'nested data reachable by query')
    const fetched = await db.collection('dogs').doc(rex.id).get()
    assert(fetched !== null && canon(fetched.data) === canon(rex.data), 'doc().get() by id matches')
  }

  // ── 7. Round 2: restore from the downloaded file ────────────
  console.log('\nRestore (uploaded local file)')
  await fetch(`${URL}/api/db/${DB}`, { method: 'DELETE', headers: auth })
  const uploadRes = await fetch(`${URL}/api/restore`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/gzip' },
    body: archive,
  })
  assert(uploadRes.ok, 'restore from uploaded archive succeeded')
  const after2 = await snapshotAll(db)
  assert(diffSnapshots(before, after2).length === 0, 'all docs byte-identical again')

  // ── Cleanup ─────────────────────────────────────────────────
  console.log('\nCleanup')
  const rmBackup = await fetch(`${URL}/api/backups/${backup.name}`, { method: 'DELETE', headers: auth })
  const rmDb = await fetch(`${URL}/api/db/${DB}`, { method: 'DELETE', headers: auth })
  assert(rmBackup.ok && rmDb.ok, 'backup + test database removed')

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
