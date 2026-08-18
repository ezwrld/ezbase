import assert from 'node:assert/strict'
import test from 'node:test'
import EzBase from '../dist/index.js'

test('realtime subscriptions send credentials only in the authorization header', async () => {
  const originalFetch = globalThis.fetch
  const requests = []
  const errors = []

  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), headers: init.headers })
    return new Response('event: snapshot\ndata: []\n\n', {
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }

  try {
    const ez = new EzBase({ url: 'https://ez.test', adminKey: 'top-secret' })
    const stops = [
      ez.collection('events').onSnapshot(() => {}, (error) => errors.push(error)),
      ez.collection('events').doc('one').onSnapshot(() => {}, (error) => errors.push(error)),
      ez.collection('events').where('type', '==', 'sync').limit(5).onSnapshot(() => {}, (error) => errors.push(error)),
    ]

    await new Promise((resolve) => setTimeout(resolve, 0))
    stops.forEach((stop) => stop())

    assert.equal(requests.length, 3)
    for (const request of requests) {
      assert.equal(request.headers.Authorization, 'Bearer top-secret')
      assert.equal(request.url.includes('top-secret'), false)
      assert.equal(new URL(request.url).searchParams.has('token'), false)
    }
    assert.deepEqual(errors.map((error) => error.message), [
      'SSE connection closed',
      'SSE connection closed',
      'SSE connection closed',
    ])
  } finally {
    globalThis.fetch = originalFetch
  }
})
