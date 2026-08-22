import { describe, expect, test } from 'bun:test'
import { documentEtag, parseDocumentEtag } from './routes.js'

describe('document ETags', () => {
  test('round-trips a retained document version', () => {
    expect(documentEtag(1787440000000)).toBe('"1787440000000"')
    expect(parseDocumentEtag('"1787440000000"')).toBe(1787440000000)
  })

  test('keeps an omitted precondition optional', () => {
    expect(parseDocumentEtag()).toBeNull()
  })

  test('rejects weak, multiple, wildcard, and unsafe ETags', () => {
    for (const value of [
      'W/"1787440000000"',
      '"1787440000000", "1787440000001"',
      '*',
      '"9007199254740992"',
    ]) {
      expect(() => parseDocumentEtag(value)).toThrow()
    }
  })
})
