import { describe, expect, test } from 'bun:test'
import { sqlIndexName } from './db.js'

describe('sqlIndexName', () => {
  test('is imported for db coverage', () => {
    expect(sqlIndexName('default', 'games', 'j', ['sport'])).toBe('idx_default_games_j_sport')
  })
})
