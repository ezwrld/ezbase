/**
 * Real-time subscriptions with SSE.
 *
 * Run: bun run examples/04-realtime.ts
 */

import { EzBase } from '@ezwrld/ezbase'

const ez = new EzBase({
  url: 'http://localhost:7003',
  adminKey: process.env.ADMIN_KEY || 'test-admin-key',
})

// ── Collection-level subscription ──────────────────────────────
console.log('Subscribing to messages collection...')

const unsub = ez.collection('messages').onSnapshot((docs) => {
  console.log(`[snapshot] ${docs.length} messages:`, docs.map(d => d.data.text))
})

// Wait a moment for the subscription to connect
await new Promise(r => setTimeout(r, 1000))

// Add some messages — each triggers a new snapshot
console.log('\nAdding messages...')
await ez.collection('messages').add({ text: 'Hello', from: 'Alice' })
await new Promise(r => setTimeout(r, 500))

await ez.collection('messages').add({ text: 'Hi there!', from: 'Bob' })
await new Promise(r => setTimeout(r, 500))

await ez.collection('messages').add({ text: 'How are you?', from: 'Alice' })
await new Promise(r => setTimeout(r, 500))

// Clean up
unsub()
console.log('\nUnsubscribed from collection.\n')

// ── Document-level subscription ────────────────────────────────
console.log('Creating a counter document...')
const counter = await ez.collection('counters').add({ value: 0 })

console.log('Subscribing to counter document...')
const unsubDoc = ez.collection('counters').doc(counter.id).onSnapshot((doc) => {
  if (doc) {
    console.log(`[counter] value = ${doc.data.value}`)
  } else {
    console.log('[counter] deleted')
  }
})

await new Promise(r => setTimeout(r, 1000))

// Update the counter — each update triggers a snapshot
for (let i = 1; i <= 3; i++) {
  await ez.collection('counters').doc(counter.id).update({ value: i })
  await new Promise(r => setTimeout(r, 500))
}

// Delete triggers a null snapshot
await ez.collection('counters').doc(counter.id).delete()
await new Promise(r => setTimeout(r, 500))

unsubDoc()
console.log('\nDone!')
process.exit(0)
