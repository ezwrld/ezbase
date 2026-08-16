import { describe, expect, test } from 'bun:test'
import { classifyRequest } from './analytics.js'

describe('classifyRequest', () => {
  test('classifies a collection below a public base path', () => {
    expect(classifyRequest('GET', '/ez/api/collections/events')).toEqual({
      op: 'read',
      database: 'default',
      collection: 'events',
    })
  })

  test('classifies a named database below a nested public base path', () => {
    expect(classifyRequest('PUT', '/services/ez/api/db/research/collections/games/1')).toEqual({
      op: 'write',
      database: 'research',
      collection: 'games',
    })
  })
})
