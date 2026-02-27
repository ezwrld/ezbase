import EzBase from './sdk/dist/index.js'

const ez = new EzBase('http://localhost:7003')

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function run() {
  console.log('--- ezbase test ---\n')

  // ── Auth ──────────────────────────────────────────────────
  console.log('=== Auth Tests ===\n')

  console.log('signing up test user...')
  const { token, user } = await ez.auth.signUp({
    email: 'test@example.com',
    password: 'password123',
  })
  console.log('signed up:', user.email, 'role:', user.role)
  console.log('got token:', token.slice(0, 20) + '...')

  console.log('\nsigning out...')
  ez.auth.signOut()
  console.log('currentUser after signOut:', ez.auth.currentUser)

  console.log('\nsigning in...')
  const { user: signedIn } = await ez.auth.signIn({
    email: 'test@example.com',
    password: 'password123',
  })
  console.log('signed in:', signedIn.email)
  console.log('currentUser:', ez.auth.currentUser?.email)

  console.log('\nduplicate signup should fail...')
  try {
    await ez.auth.signUp({ email: 'test@example.com', password: 'password123' })
    console.log('ERROR: should have thrown')
  } catch (err) {
    console.log('correctly rejected:', err.message)
  }

  console.log('\nbad password should fail...')
  try {
    await ez.auth.signIn({ email: 'test@example.com', password: 'wrong' })
    console.log('ERROR: should have thrown')
  } catch (err) {
    console.log('correctly rejected:', err.message)
  }

  // Sign out for CRUD tests (public collections still work)
  ez.auth.signOut()

  // ── CRUD ────────────────────────────────────────────────────
  console.log('\n=== CRUD Tests ===\n')

  console.log('adding users...')
  const alice = await ez.collection('users').add({ name: 'Alice', age: 30, role: 'admin' })
  const bob = await ez.collection('users').add({ name: 'Bob', age: 25, role: 'member' })
  const charlie = await ez.collection('users').add({ name: 'Charlie', age: 35, role: 'member' })
  console.log('alice:', alice.id)
  console.log('bob:', bob.id)
  console.log('charlie:', charlie.id)

  console.log('\nget alice by id...')
  const fetched = await ez.collection('users').doc(alice.id).get()
  console.log('fetched:', fetched?.data.name)

  console.log('\nget all users...')
  const all = await ez.collection('users').get()
  console.log(`got ${all.length} users`)

  // ── Queries ─────────────────────────────────────────────────
  console.log('\nquery age >= 30...')
  const older = await ez.collection('users').where('age', '>=', 30).get()
  console.log('results:', older.map((d) => d.data.name))

  console.log('\nquery role == member, order by age desc, limit 1...')
  const top = await ez
    .collection('users')
    .where('role', '==', 'member')
    .orderBy('age', 'desc')
    .limit(1)
    .get()
  console.log('result:', top[0]?.data.name)

  // ── Compound queries (no index needed!) ─────────────────────
  console.log('\ncompound: role == member AND age > 24...')
  const compound = await ez
    .collection('users')
    .where('role', '==', 'member')
    .where('age', '>', 24)
    .get()
  console.log('results:', compound.map((d) => `${d.data.name} (${d.data.age})`))

  // ── Update / Set ────────────────────────────────────────────
  console.log('\nupdate alice age to 31...')
  const updated = await ez.collection('users').doc(alice.id).update({ age: 31 })
  console.log('updated:', updated.data)

  console.log('\nset bob to entirely new data...')
  const replaced = await ez.collection('users').doc(bob.id).set({ name: 'Bob V2', age: 26 })
  console.log('replaced:', replaced.data)

  console.log('\nset with custom id "special"...')
  const special = await ez.collection('users').doc('special').set({ name: 'Custom ID', age: 99 })
  console.log('special:', special.id, special.data)

  console.log('\nget nonexistent doc...')
  const nope = await ez.collection('users').doc('doesnotexist').get()
  console.log('not found:', nope)

  console.log('\ndelete charlie...')
  await ez.collection('users').doc(charlie.id).delete()
  const afterDelete = await ez.collection('users').get()
  console.log(`users after delete: ${afterDelete.length}`)

  // ── SSE: realtime subscriptions ─────────────────────────────
  console.log('\n=== SSE Tests ===\n')

  // doc-level subscription
  console.log('subscribing to alice doc...')
  const docSnapshots = []
  const unsubDoc = ez.collection('users').doc(alice.id).onSnapshot((doc) => {
    docSnapshots.push(doc)
  })

  // collection-level subscription
  console.log('subscribing to "animals" collection...')
  const colSnapshots = []
  const unsubCol = ez.collection('animals').onSnapshot((docs) => {
    colSnapshots.push(docs)
  })

  // query subscription
  console.log('subscribing to users where age >= 30...')
  const querySnapshots = []
  const unsubQuery = ez
    .collection('users')
    .where('age', '>=', 30)
    .onSnapshot((docs) => {
      querySnapshots.push(docs)
    })

  // wait for initial snapshots
  await sleep(500)

  console.log(`\ninitial doc snapshot: ${docSnapshots[0]?.data?.name ?? 'null'}`)
  console.log(`initial collection snapshot: ${colSnapshots[0]?.length} animals`)
  console.log(`initial query snapshot: ${querySnapshots[0]?.length} users with age >= 30`)

  // trigger changes
  console.log('\nadding a dog to animals...')
  await ez.collection('animals').add({ species: 'dog', name: 'Rex' })
  await sleep(300)
  console.log(`collection snapshot after add: ${colSnapshots.at(-1)?.length} animals`)

  console.log('\nupdating alice age to 32...')
  await ez.collection('users').doc(alice.id).update({ age: 32 })
  await sleep(300)
  console.log(`doc snapshot after update: age=${docSnapshots.at(-1)?.data?.age}`)
  console.log(`query snapshot after update: ${querySnapshots.at(-1)?.map((d) => d.data.name)}`)

  // unsubscribe
  unsubDoc()
  unsubCol()
  unsubQuery()
  console.log('\nunsubscribed all listeners')

  // ── Cleanup ─────────────────────────────────────────────────
  console.log('\ncleaning up...')
  const remainingUsers = await ez.collection('users').get()
  for (const u of remainingUsers) await ez.collection('users').doc(u.id).delete()
  const remainingAnimals = await ez.collection('animals').get()
  for (const a of remainingAnimals) await ez.collection('animals').doc(a.id).delete()

  console.log('\n--- all tests passed ---')
  process.exit(0)
}

run().catch((err) => {
  console.error('FAILED:', err.message)
  process.exit(1)
})
