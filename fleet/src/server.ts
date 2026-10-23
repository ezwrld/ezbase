import path from 'node:path'
import { api, bucket, cached, fleet, instance, start, type Instance } from './fleet'

const PORT = 7490
const HOST = 'ezbase.localhost'
const WEB_DIR = path.resolve(import.meta.dir, '../dist')
const CONSOLE_DIR = path.resolve(import.meta.dir, '../console')

start()

Bun.serve({
  port: PORT,
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url)
    const hostname = (req.headers.get('host') || '').split(':')[0]
    if (hostname.endsWith(`.${HOST}`)) {
      const i = instance(hostname.slice(0, -HOST.length - 1))
      if (!i) return new Response('Unknown instance', { status: 404 })
      return consoleFor(i, req, url)
    }
    if (url.pathname === '/api/fleet') return Response.json(fleet())
    const detail = url.pathname.match(/^\/api\/instances\/([^/]+)$/)
    if (detail) return instanceDetail(detail[1])
    return serveStatic(WEB_DIR, url.pathname === '/' ? '/index.html' : url.pathname, '/index.html')
  },
})

console.log(`ezbase fleet: http://${HOST}:${PORT}`)

async function instanceDetail(id: string) {
  const i = instance(id)
  if (!i) return Response.json({ error: 'Unknown instance' }, { status: 404 })
  const { key, base, ...rest } = i
  const view = { ...rest, keyed: Boolean(key) }
  if (i.state !== 'up' || !key) return Response.json({ instance: view, series: [], top: [], collections: [], indexes: [], backups: [] })

  type Point = { ts: number; requests: number; errors: number; avgMs: number }
  const [series, summary] = await Promise.allSettled([
    api<Point[]>(i, '/analytics/timeseries?minutes=1440'),
    api<{ topCollections: unknown[] }>(i, '/analytics/summary?hours=24'),
  ])
  return Response.json({
    instance: view,
    series: series.status === 'fulfilled' ? bucket(series.value, 1440, 144) : [],
    top: summary.status === 'fulfilled' ? summary.value.topCollections : [],
    ...cached(i.id),
  })
}

/**
 * Each instance gets its own origin (<id>.ezbase.localhost) serving the bundled console,
 * with /api proxied to the instance and the admin key added here, never sent to the browser.
 */
async function consoleFor(i: Instance, req: Request, url: URL) {
  if (url.pathname === '/' ) return Response.redirect(`${url.origin}/console/`, 302)
  if (url.pathname.startsWith('/console')) {
    const rel = url.pathname.slice('/console'.length) || '/'
    const res = await serveStatic(CONSOLE_DIR, rel === '/' ? '/index.html' : rel, '/index.html')
    if (!res.headers.get('content-type')?.startsWith('text/html') || !i.key) return res
    const html = (await res.text()).replace('<head>', `<head><script>localStorage.setItem('ezbase_admin_key','fleet')</script>`)
    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
  }
  if (!url.pathname.startsWith('/api/')) return new Response('Not found', { status: 404 })
  if (!i.base) return Response.json({ error: `${i.name} is ${i.state}` }, { status: 502 })

  const site = req.headers.get('sec-fetch-site')
  if (site && site !== 'same-origin' && site !== 'none') return new Response('Forbidden', { status: 403 })

  const headers = new Headers(req.headers)
  for (const h of ['host', 'origin', 'referer', 'cookie', 'accept-encoding']) headers.delete(h)
  const search = new URLSearchParams(url.search)
  if (i.key) {
    headers.set('authorization', `Bearer ${i.key}`)
    search.delete('token')
  }
  const query = search.toString()
  const upstream = await fetch(`${i.base}${url.pathname}${query ? `?${query}` : ''}`, {
    method: req.method,
    headers,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req.body,
    redirect: 'manual',
  }).catch((e) => Response.json({ error: String(e) }, { status: 502 }))
  const out = new Headers(upstream.headers)
  out.delete('content-encoding')
  out.delete('content-length')
  return new Response(upstream.body, { status: upstream.status, headers: out })
}

async function serveStatic(dir: string, pathname: string, fallback: string) {
  const file = Bun.file(path.join(dir, path.normalize(pathname).replace(/^(\.\.[/\\])+/, '')))
  if (await file.exists()) {
    const immutable = pathname.includes('/assets/') || /-[a-z0-9]{8,}\.(js|css)$/.test(pathname)
    return new Response(file, { headers: immutable ? { 'cache-control': 'public, max-age=31536000, immutable' } : {} })
  }
  return new Response(Bun.file(path.join(dir, fallback)), { headers: { 'content-type': 'text/html; charset=utf-8' } })
}
