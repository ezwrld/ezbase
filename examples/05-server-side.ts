/**
 * Server-side usage: your backend uses ezbase with admin key as the data layer.
 * This pattern is how you'd use ezbase from an Express/Hono/Fastify backend.
 *
 * Run: bun run examples/05-server-side.ts
 */

import { EzBase } from '@ezwrld/ezbase'

// Your backend connects to ezbase with the admin key.
// In Docker Compose, use the internal hostname (e.g. http://ezbase:7003).
const ez = new EzBase({
  url: process.env.EZBASE_URL || 'http://localhost:7003',
  adminKey: process.env.EZBASE_ADMIN_KEY || 'test-admin-key',
})

// ── Example: User management layer ────────────────────────────
// Your app handles its own auth/logic, ezbase stores the data.

async function createUserProfile(userId: string, data: { name: string; bio?: string }) {
  return ez.collection('profiles').doc(userId).set({
    ...data,
    createdAt: Date.now(),
  })
}

async function getUserProfile(userId: string) {
  return ez.collection('profiles').doc(userId).get()
}

async function updateUserProfile(userId: string, updates: Record<string, unknown>) {
  return ez.collection('profiles').doc(userId).update(updates)
}

// ── Example: Task queue ───────────────────────────────────────

async function enqueueTask(type: string, payload: unknown) {
  return ez.collection('tasks').add({
    type,
    payload,
    status: 'pending',
    attempts: 0,
    createdAt: Date.now(),
  })
}

async function processNextTask() {
  const pending = await ez.collection('tasks')
    .where('status', '==', 'pending')
    .orderBy('created', 'asc')
    .limit(1)
    .get()

  if (pending.length === 0) return null

  const task = pending[0]

  // Mark as processing
  await ez.collection('tasks').doc(task.id).update({
    status: 'processing',
    startedAt: Date.now(),
  })

  try {
    // Do the work...
    console.log(`Processing task ${task.id}: ${task.data.type}`)

    // Mark as completed
    await ez.collection('tasks').doc(task.id).update({
      status: 'completed',
      completedAt: Date.now(),
    })

    return task
  } catch (err) {
    // Mark as failed
    await ez.collection('tasks').doc(task.id).update({
      status: 'failed',
      error: String(err),
      attempts: (task.data.attempts as number) + 1,
    })
    return null
  }
}

// ── Example: Analytics / event logging ─────────────────────────

async function logEvent(event: string, properties: Record<string, unknown>) {
  return ez.collection('events').add({
    event,
    properties,
    timestamp: Date.now(),
  })
}

async function getRecentEvents(event: string, limit = 50) {
  return ez.collection('events')
    .where('event', '==', event)
    .orderBy('created', 'desc')
    .limit(limit)
    .get()
}

// ── Run the examples ──────────────────────────────────────────

console.log('--- User Profiles ---')
await createUserProfile('user-1', { name: 'Alice', bio: 'Builder of things' })
await createUserProfile('user-2', { name: 'Bob' })
const profile = await getUserProfile('user-1')
console.log('Profile:', profile?.data)

await updateUserProfile('user-1', { bio: 'Builder of great things' })
const updated = await getUserProfile('user-1')
console.log('Updated:', updated?.data)

console.log('\n--- Task Queue ---')
await enqueueTask('send-email', { to: 'alice@example.com', subject: 'Welcome!' })
await enqueueTask('generate-report', { reportId: 'monthly-2024-01' })
await enqueueTask('send-email', { to: 'bob@example.com', subject: 'Hello!' })

await processNextTask()
await processNextTask()

const remaining = await ez.collection('tasks')
  .where('status', '==', 'pending')
  .get()
console.log(`Remaining pending tasks: ${remaining.length}`)

console.log('\n--- Analytics ---')
await logEvent('page_view', { page: '/home', referrer: 'google.com' })
await logEvent('page_view', { page: '/pricing', referrer: '/home' })
await logEvent('signup', { plan: 'free' })
await logEvent('page_view', { page: '/dashboard', referrer: '/pricing' })

const pageViews = await getRecentEvents('page_view')
console.log(`Recent page views: ${pageViews.length}`)
console.log('Pages:', pageViews.map(e => e.data.properties.page))
