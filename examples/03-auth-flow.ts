/**
 * Full auth flow: sign up, sign in, authenticated requests, sign out.
 *
 * Run: bun run examples/03-auth-flow.ts
 */

import { EzBase } from '@ezwrld/ezbase'

const URL = 'http://localhost:7003'
const ADMIN_KEY = process.env.ADMIN_KEY || 'test-admin-key'

// ── 1. Set up a collection that requires auth ──────────────────
const admin = new EzBase({ url: URL, adminKey: ADMIN_KEY })

// Make 'notes' require authentication
await fetch(`${URL}/api/collections/notes/permissions`, {
  method: 'PUT',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${ADMIN_KEY}`,
  },
  body: JSON.stringify({ level: 'authenticated' }),
})
console.log('Set notes collection to authenticated\n')

// ── 2. Try anonymous access (should fail) ──────────────────────
const anon = new EzBase({ url: URL })
try {
  await anon.collection('notes').add({ title: 'Should fail' })
  console.log('ERROR: Anonymous access should have failed!')
} catch (err: any) {
  console.log('Anonymous access blocked:', err.message)
}

// ── 3. Sign up a new user ──────────────────────────────────────
const client = new EzBase({ url: URL })

const { token, user } = await client.auth.signUp({
  email: 'alice@example.com',
  password: 'securepassword123',
})
console.log('\nSigned up:', user)
console.log('Session token:', token.slice(0, 10) + '...')
console.log('Current user:', client.auth.currentUser)

// ── 4. Create data as authenticated user ───────────────────────
const note = await client.collection('notes').add({
  title: 'My first note',
  content: 'ezbase auth works!',
  userId: client.auth.currentUser!.id,
})
console.log('\nCreated note as authenticated user:', note.data.title)

// ── 5. Sign out ────────────────────────────────────────────────
await client.auth.signOut()
console.log('\nSigned out. Current user:', client.auth.currentUser) // null

// Requests now fail again
try {
  await client.collection('notes').get()
  console.log('ERROR: Should have failed after sign out!')
} catch (err: any) {
  console.log('After sign out, access blocked:', err.message)
}

// ── 6. Sign back in ───────────────────────────────────────────
const { user: user2 } = await client.auth.signIn({
  email: 'alice@example.com',
  password: 'securepassword123',
})
console.log('\nSigned back in:', user2.email)

// Can access notes again
const notes = await client.collection('notes').get()
console.log('Notes:', notes.map(n => n.data.title))

// ── 7. Auth state listener ─────────────────────────────────────
const unsub = client.auth.onAuthStateChanged((user) => {
  console.log('Auth state changed:', user ? `signed in as ${user.email}` : 'signed out')
})

await client.auth.signOut()   // triggers listener
unsub()                        // stop listening

// ── 8. Admin always has access ─────────────────────────────────
const adminNotes = await admin.collection('notes').get()
console.log('\nAdmin can always read notes:', adminNotes.length, 'notes')
