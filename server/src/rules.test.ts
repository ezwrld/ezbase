import { describe, expect, test } from 'bun:test'
import { DEFAULT_RULES, validateRules } from './rules.js'

describe('default rules', () => {
  test('deny access to unconfigured collections and buckets', () => {
    expect(DEFAULT_RULES).toEqual({ default: 'admin' })
    expect(validateRules(DEFAULT_RULES)).toBe(true)
  })
})
