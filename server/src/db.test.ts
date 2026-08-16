import { afterEach, describe, expect, test } from 'bun:test'
import { shouldCreateDataIndex } from './db.js'

afterEach(() => {
  delete process.env.EZBASE_GIN_EXCLUDE
})

describe('shouldCreateDataIndex', () => {
  test('creates the data index by default', () => {
    expect(shouldCreateDataIndex('events')).toBe(true)
  })

  test('skips configured collections', () => {
    process.env.EZBASE_GIN_EXCLUDE = 'game_metric_heads, source_payloads'
    expect(shouldCreateDataIndex('game_metric_heads')).toBe(false)
    expect(shouldCreateDataIndex('source_payloads')).toBe(false)
    expect(shouldCreateDataIndex('events')).toBe(true)
  })
})
