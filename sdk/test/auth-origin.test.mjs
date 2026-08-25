import assert from 'node:assert/strict'
import test from 'node:test'
import EzBase from '../dist/index.js'

test('auth POSTs send Origin so Node/Bun clients satisfy BetterAuth CSRF', async () => {
  const originalFetch = globalThis.fetch
  const requests = []

  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), headers: init.headers, method: init.method })
    return new Response(JSON.stringify({
      token: 'sess',
      user: { id: 'u1', email: 'a@b.c', role: 'user', claims: '{}' },
      session: { token: 'sess' },
    }), { headers: { 'Content-Type': 'application/json' } })
  }

  try {
    const ez = new EzBase({ url: 'https://ez.test:7003' })
    await ez.auth.signUp({ email: 'a@b.c', password: 'password1' })
    await ez.auth.signIn({ email: 'a@b.c', password: 'password1' })
    await ez.auth.requestPasswordReset('a@b.c')

    assert.equal(requests.length, 3)
    for (const request of requests) {
      assert.equal(request.headers.Origin, 'https://ez.test:7003')
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})
