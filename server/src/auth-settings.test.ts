import { describe, expect, test } from 'bun:test'
import { originOf, validateAuthFile } from './auth-settings.js'

describe('validateAuthFile', () => {
  test('accepts empty object', () => {
    expect(validateAuthFile({})).toBe(true)
  })

  test('accepts providers and extra origins', () => {
    expect(validateAuthFile({
      publicUrl: 'https://aura.tl/ez',
      extraOrigins: ['https://admin.aura.tl'],
      providers: {
        google: { clientId: 'id', clientSecret: 'secret' },
        github: null,
      },
    })).toBe(true)
  })

  test('rejects junk', () => {
    expect(validateAuthFile(null)).toBe(false)
    expect(validateAuthFile({ extraOrigins: 'nope' })).toBe(false)
    expect(validateAuthFile({ providers: { google: { clientId: 1 } } })).toBe(false)
  })
})

describe('originOf', () => {
  test('strips path', () => {
    expect(originOf('https://aura.tl/ez')).toBe('https://aura.tl')
  })
})
