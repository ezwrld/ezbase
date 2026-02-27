import { sql } from './db.js'

export type ChangeEvent = {
  type: 'added' | 'modified' | 'removed'
  id: string
  collection: string
  database: string
}

type Listener = (event: ChangeEvent) => void

const listeners = new Map<string, Set<Listener>>()

export async function initPubSub() {
  await sql.listen('ezbase_changes', (payload) => {
    const event = JSON.parse(payload) as ChangeEvent
    const key = `${event.database}:${event.collection}`
    const set = listeners.get(key)
    if (set) {
      for (const l of set) {
        try {
          l(event)
        } catch {}
      }
    }
  })
  console.log('pubsub connected (postgres LISTEN/NOTIFY)')
}

export async function publishChange(event: ChangeEvent) {
  await sql.notify('ezbase_changes', JSON.stringify(event))
}

export async function subscribe(
  database: string,
  collection: string,
  listener: Listener
): Promise<() => void> {
  const key = `${database}:${collection}`
  if (!listeners.has(key)) {
    listeners.set(key, new Set())
  }
  listeners.get(key)!.add(listener)

  return () => {
    const set = listeners.get(key)
    if (set) {
      set.delete(listener)
      if (set.size === 0) {
        listeners.delete(key)
      }
    }
  }
}
