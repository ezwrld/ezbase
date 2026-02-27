import { sql } from './db.js'

export type ChangeEvent = {
  type: 'added' | 'modified' | 'removed'
  id: string
  collection: string
}

type Listener = (event: ChangeEvent) => void

const listeners = new Map<string, Set<Listener>>()

export async function initPubSub() {
  await sql.listen('ezbase_changes', (payload) => {
    const event = JSON.parse(payload) as ChangeEvent
    const set = listeners.get(event.collection)
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
  collection: string,
  listener: Listener
): Promise<() => void> {
  if (!listeners.has(collection)) {
    listeners.set(collection, new Set())
  }
  listeners.get(collection)!.add(listener)

  return () => {
    const set = listeners.get(collection)
    if (set) {
      set.delete(listener)
      if (set.size === 0) {
        listeners.delete(collection)
      }
    }
  }
}
