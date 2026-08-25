import { afterEach, describe, expect, test } from 'bun:test'
import { buildQuerySql, collectIndexHints, parseWhere, sanitizeField } from './query.js'

afterEach(() => {
  delete process.env.EZBASE_AUTO_INDEX
})

describe('sanitizeField', () => {
  test('accepts identifiers', () => {
    expect(sanitizeField('observedAt')).toBe('observedAt')
  })

  test('rejects injection', () => {
    expect(() => sanitizeField("status'; drop")).toThrow()
  })
})

describe('collectIndexHints', () => {
  test('captures Aura lease query', () => {
    const hints = collectIndexHints(
      parseWhere(JSON.stringify([['status', '==', 'pending']])),
      'observedAt'
    )
    expect(hints.eqFields).toEqual(['status'])
    expect(hints.jsonFields).toEqual(['status', 'observedAt'])
    expect(hints.orderField).toBe('observedAt')
  })

  test('maps created/updated to timestamp columns', () => {
    const hints = collectIndexHints(
      parseWhere(JSON.stringify([['status', '==', 'acked'], ['created', '<', 1]])),
      'created'
    )
    expect(hints.eqFields).toEqual(['status'])
    expect(hints.orderField).toBe('created_at')
  })

  test('keeps three equality filters for a composite', () => {
    const hints = collectIndexHints(
      parseWhere(JSON.stringify([
        ['sport', '==', 'NBA'],
        ['status', '==', 'acked'],
        ['source', '==', 'espn.summary'],
      ])),
      'observedAt'
    )
    expect(hints.eqFields).toEqual(['sport', 'status', 'source'])
    expect(hints.orderField).toBe('observedAt')
  })
})

describe('buildQuerySql', () => {
  test('uses jsonb predicates when auto-index is on', () => {
    const { query, params } = buildQuerySql(
      'default',
      'events',
      JSON.stringify([['status', '==', 'pending']]),
      'observedAt',
      'asc',
      '25',
      undefined,
      undefined,
      ['status', 'observedAt'],
      true,
      true
    )
    expect(query).toContain(`data->'status' = to_jsonb($1::text)`)
    expect(query).toContain(`ORDER BY data->'observedAt' ASC`)
    expect(query).not.toContain('@>')
    expect(params[0]).toBe('pending')
    expect(params[1]).toBe(25)
  })

  test('keeps GIN containment when auto-index is off', () => {
    const { query, params } = buildQuerySql(
      'default',
      'events',
      JSON.stringify([['status', '==', 'pending']]),
      'observedAt',
      'asc',
      '25',
      undefined,
      undefined,
      undefined,
      true,
      false
    )
    expect(query).toContain('@>')
    expect(params[0]).toBe('{"status":"pending"}')
  })

  test('uses jsonb compare for numeric ranges', () => {
    const { query } = buildQuerySql(
      'default',
      'games',
      JSON.stringify([
        ['sport', '==', 'MLB'],
        ['startsAtMs', '>=', 1700000000000],
        ['startsAtMs', '<', 1730000000000],
      ]),
      'startsAtMs',
      'asc',
      '250',
      undefined,
      undefined,
      undefined,
      true,
      true
    )
    expect(query).toContain(`data->'startsAtMs' >= to_jsonb($2::numeric)`)
    expect(query).toContain(`data->'startsAtMs' < to_jsonb($3::numeric)`)
  })

  test('sorts updated via the timestamp column', () => {
    const { query } = buildQuerySql(
      'default',
      'games',
      undefined,
      'updated',
      'desc',
      '50',
      undefined,
      undefined,
      undefined,
      true,
      true
    )
    expect(query).toContain('ORDER BY updated_at DESC')
  })

  test('treats != as jsonb IS DISTINCT FROM', () => {
    const { query } = buildQuerySql(
      'default',
      'events',
      JSON.stringify([['status', '!=', 'acked']]),
      undefined,
      undefined,
      '10',
      undefined,
      undefined,
      undefined,
      true,
      true
    )
    expect(query).toContain(`data->'status' IS DISTINCT FROM to_jsonb($1::text)`)
  })

  test('defaults list size to 100 even for admin', () => {
    const { query, params } = buildQuerySql(
      'default',
      'events',
      undefined,
      'created',
      'desc',
      undefined,
      undefined,
      undefined,
      undefined,
      true,
      true
    )
    expect(query).toContain('LIMIT')
    expect(params.at(-1)).toBe(100)
  })

  test('rejects non-positive limit', () => {
    expect(() =>
      buildQuerySql(
        'default',
        'events',
        undefined,
        undefined,
        undefined,
        '0',
        undefined,
        undefined,
        undefined,
        true,
        true
      )
    ).toThrow('limit must be a positive integer')
  })
})
