/**
 * Basic CRUD operations with ezbase.
 *
 * Prerequisites:
 *   - ezbase running at http://localhost:7003
 *   - npm install @ezwrld/ezbase
 *
 * Run: bun run examples/01-basic-crud.ts
 */

import { EzBase } from '@ezwrld/ezbase'

const ez = new EzBase({
  url: 'http://localhost:7003',
  adminKey: process.env.ADMIN_KEY || 'test-admin-key',
})

// Create documents — collection is created automatically
const todo1 = await ez.collection('todos').add({
  title: 'Learn ezbase',
  done: false,
  tags: ['learning', 'database'],
})
console.log('Created:', todo1)

const todo2 = await ez.collection('todos').add({
  title: 'Build something cool',
  done: false,
  tags: ['project'],
})

// Read a single document
const fetched = await ez.collection('todos').doc(todo1.id).get()
console.log('Fetched:', fetched)

// List all documents
const all = await ez.collection('todos').get()
console.log(`All todos (${all.length}):`, all.map(d => d.data.title))

// Update (merge) — only changes the fields you pass
const updated = await ez.collection('todos').doc(todo1.id).update({ done: true })
console.log('Updated:', updated.data)
// → { title: 'Learn ezbase', done: true, tags: ['learning', 'database'] }

// Replace (overwrite) — replaces the entire data object
const replaced = await ez.collection('todos').doc(todo2.id).set({
  title: 'Build something cool',
  done: true,
  completedAt: Date.now(),
})
console.log('Replaced:', replaced.data)

// Delete
await ez.collection('todos').doc(todo1.id).delete()
const deleted = await ez.collection('todos').doc(todo1.id).get()
console.log('After delete:', deleted) // null

// List collections
const res = await fetch('http://localhost:7003/api/collections', {
  headers: { Authorization: `Bearer ${process.env.ADMIN_KEY || 'test-admin-key'}` },
})
console.log('Collections:', await res.json())
