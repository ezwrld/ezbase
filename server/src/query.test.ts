import { describe, expect, test } from 'bun:test'
import { buildQuerySql, sanitizeField } from './query.js'

describe('sanitizeField', () => {
  test('accepts identifiers', () => {
    expect(sanitizeField('observedAt')).toBe('observedAt')
  })

  test('rejects injection', () => {
    expect(() => sanitizeField("status'; drop")).toThrow()
  })
})

describe('buildQuerySql', () => {
  test('uses jsonb predicates', () => {
    const { query, params } = buildQuerySql(
      'default',
      'events',
      JSON.stringify([['status', '==', 'pending']]),
      'observedAt',
      'asc',
      '25',
      undefined,
      undefined,
      ['status', 'observedAt']
    )
    expect(query).toContain(`data->'status' = to_jsonb($1::text)`)
    expect(query).toContain(`ORDER BY data->'observedAt' ASC`)
    expect(query).not.toContain('@>')
    expect(params[0]).toBe('pending')
    expect(params[1]).toBe(25)
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
      undefined
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
      undefined
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
      undefined
    )
    expect(query).toContain(`data->'status' IS DISTINCT FROM to_jsonb($1::text)`)
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
        undefined
      )
    ).toThrow('limit must be a positive integer')
  })
})
