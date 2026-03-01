import { Hono } from 'hono'
import type { Context, Next } from 'hono'
import { mkdir, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { sql } from './db.js'
import { getBucketAccess } from './rules.js'
import { generateId } from './id.js'

const STORAGE_PATH = process.env.STORAGE_PATH || '/data/files'
const MAX_FILE_SIZE = parseInt(process.env.EZBASE_MAX_FILE_SIZE || '104857600') // 100MB

const PATH_RE = /^[a-zA-Z0-9][a-zA-Z0-9_\-./]*$/

function sanitizePath(path: string): string | null {
  if (!PATH_RE.test(path)) return null
  if (path.includes('..')) return null
  if (path.endsWith('/')) return null
  // Collapse double slashes
  const cleaned = path.replace(/\/+/g, '/')
  if (!PATH_RE.test(cleaned)) return null
  return cleaned
}

function extractBucket(path: string): string {
  return path.split('/')[0]
}

// ── Permission middleware ──────────────────────────────────────

function requireStorageAccess(action: 'read' | 'write' | 'delete') {
  return async (c: Context, next: Next) => {
    const role = c.get('role') || 'anonymous'
    if (role === 'admin') return next()

    const bucket = c.req.param('bucket')
    const access = getBucketAccess(bucket)

    if (access === 'public') {
      return next()
    }

    if (access === 'authenticated') {
      if (role === 'anonymous') return c.json({ error: 'Unauthorized' }, 401)
      return next()
    }

    if (access === 'admin') {
      if (role === 'anonymous') return c.json({ error: 'Unauthorized' }, 401)
      return c.json({ error: 'Forbidden' }, 403)
    }

    if (access.startsWith('role:')) {
      const required = access.slice(5)
      if (role === 'anonymous') return c.json({ error: 'Unauthorized' }, 401)
      if (role !== required) return c.json({ error: 'Forbidden' }, 403)
      return next()
    }

    if (access === 'owner') {
      if (role === 'anonymous') return c.json({ error: 'Unauthorized' }, 401)

      // Uploads: any authenticated user can upload
      if (action === 'write') return next()

      // Read/delete: check uploaded_by — handled per-route via context flag
      c.set('storageOwnerFilter', true)
      return next()
    }

    // Unknown access level — deny
    return c.json({ error: 'Forbidden' }, 403)
  }
}

// ── Routes ────────────────────────────────────────────────────

const storageRoutes = new Hono()

// List all buckets (admin only)
storageRoutes.get('/storage', async (c) => {
  const role = c.get('role') || 'anonymous'
  if (role !== 'admin') {
    return c.json({ error: role === 'anonymous' ? 'Unauthorized' : 'Forbidden' }, role === 'anonymous' ? 401 : 403)
  }

  const rows = await sql`SELECT DISTINCT bucket FROM _ezbase_files ORDER BY bucket`
  return c.json(rows.map(r => r.bucket))
})

// Upload file to bucket (auto-generated path)
storageRoutes.post('/storage/:bucket', requireStorageAccess('write'), async (c) => {
  const bucket = c.req.param('bucket')

  const formData = await c.req.formData()
  const file = formData.get('file') as File | null
  if (!file) return c.json({ error: 'No file provided' }, 400)
  if (file.size > MAX_FILE_SIZE) return c.json({ error: 'File too large' }, 413)

  const filename = `${generateId()}_${file.name}`
  const fullPath = `${bucket}/${filename}`

  if (!sanitizePath(fullPath)) return c.json({ error: 'Invalid path' }, 400)

  const diskPath = `${STORAGE_PATH}/${fullPath}`
  await mkdir(dirname(diskPath), { recursive: true })
  await Bun.write(diskPath, file)

  const now = Date.now()
  const userId = c.get('userId') as string | undefined

  await sql`
    INSERT INTO _ezbase_files (path, bucket, filename, size, mime_type, uploaded_by, created_at, updated_at)
    VALUES (${fullPath}, ${bucket}, ${file.name}, ${file.size}, ${file.type || 'application/octet-stream'}, ${userId || null}, ${now}, ${now})
    ON CONFLICT (path) DO UPDATE SET
      size = EXCLUDED.size, mime_type = EXCLUDED.mime_type,
      uploaded_by = EXCLUDED.uploaded_by, updated_at = EXCLUDED.updated_at
  `

  return c.json({
    path: fullPath,
    bucket,
    filename: file.name,
    size: file.size,
    mimeType: file.type || 'application/octet-stream',
    uploadedBy: userId || null,
    created: now,
    updated: now,
    url: `/api/storage/${fullPath}`,
  }, 201)
})

// Upload file to specific path
storageRoutes.post('/storage/:bucket/:path{.+}', requireStorageAccess('write'), async (c) => {
  const bucket = c.req.param('bucket')
  const pathParam = c.req.param('path')
  if (!pathParam) return c.json({ error: 'Path required' }, 400)

  const formData = await c.req.formData()
  const file = formData.get('file') as File | null
  if (!file) return c.json({ error: 'No file provided' }, 400)
  if (file.size > MAX_FILE_SIZE) return c.json({ error: 'File too large' }, 413)

  const fullPath = `${bucket}/${pathParam}`
  if (!sanitizePath(fullPath)) return c.json({ error: 'Invalid path' }, 400)

  const diskPath = `${STORAGE_PATH}/${fullPath}`
  await mkdir(dirname(diskPath), { recursive: true })
  await Bun.write(diskPath, file)

  const now = Date.now()
  const userId = c.get('userId') as string | undefined

  await sql`
    INSERT INTO _ezbase_files (path, bucket, filename, size, mime_type, uploaded_by, created_at, updated_at)
    VALUES (${fullPath}, ${bucket}, ${file.name}, ${file.size}, ${file.type || 'application/octet-stream'}, ${userId || null}, ${now}, ${now})
    ON CONFLICT (path) DO UPDATE SET
      size = EXCLUDED.size, mime_type = EXCLUDED.mime_type,
      uploaded_by = EXCLUDED.uploaded_by, updated_at = EXCLUDED.updated_at
  `

  return c.json({
    path: fullPath,
    bucket,
    filename: file.name,
    size: file.size,
    mimeType: file.type || 'application/octet-stream',
    uploadedBy: userId || null,
    created: now,
    updated: now,
    url: `/api/storage/${fullPath}`,
  }, 201)
})

// List files in bucket
storageRoutes.get('/storage/:bucket', requireStorageAccess('read'), async (c) => {
  const bucket = c.req.param('bucket')
  const ownerFilter = c.get('storageOwnerFilter')
  const userId = c.get('userId') as string | undefined

  let rows
  if (ownerFilter && userId) {
    rows = await sql`SELECT * FROM _ezbase_files WHERE bucket = ${bucket} AND uploaded_by = ${userId} ORDER BY created_at DESC`
  } else {
    rows = await sql`SELECT * FROM _ezbase_files WHERE bucket = ${bucket} ORDER BY created_at DESC`
  }

  return c.json(rows.map(r => ({
    path: r.path,
    bucket: r.bucket,
    filename: r.filename,
    size: Number(r.size),
    mimeType: r.mime_type,
    uploadedBy: r.uploaded_by,
    created: Number(r.created_at),
    updated: Number(r.updated_at),
    url: `/api/storage/${r.path}`,
  })))
})

// Download file
storageRoutes.get('/storage/:bucket/:path{.+}', requireStorageAccess('read'), async (c) => {
  const bucket = c.req.param('bucket')
  const pathParam = c.req.param('path')
  if (!pathParam) return c.json({ error: 'Path required' }, 400)

  const fullPath = `${bucket}/${pathParam}`
  if (!sanitizePath(fullPath)) return c.json({ error: 'Invalid path' }, 400)

  // Owner check
  const ownerFilter = c.get('storageOwnerFilter')
  if (ownerFilter) {
    const userId = c.get('userId') as string | undefined
    const meta = await sql`SELECT uploaded_by FROM _ezbase_files WHERE path = ${fullPath}`
    if (meta.length === 0) return c.json({ error: 'File not found' }, 404)
    if (meta[0].uploaded_by !== userId) return c.json({ error: 'Forbidden' }, 403)
  }

  const diskPath = `${STORAGE_PATH}/${fullPath}`
  const bunFile = Bun.file(diskPath)
  if (!await bunFile.exists()) return c.json({ error: 'File not found' }, 404)

  const rows = await sql`SELECT mime_type, size FROM _ezbase_files WHERE path = ${fullPath}`
  const mimeType = rows.length > 0 ? rows[0].mime_type : 'application/octet-stream'
  const size = rows.length > 0 ? rows[0].size : bunFile.size

  c.header('Content-Type', mimeType as string)
  c.header('Content-Length', String(size))
  c.header('Cache-Control', 'private, max-age=3600')

  return c.body(bunFile.stream())
})

// Delete file
storageRoutes.delete('/storage/:bucket/:path{.+}', requireStorageAccess('delete'), async (c) => {
  const bucket = c.req.param('bucket')
  const pathParam = c.req.param('path')
  if (!pathParam) return c.json({ error: 'Path required' }, 400)

  const fullPath = `${bucket}/${pathParam}`
  if (!sanitizePath(fullPath)) return c.json({ error: 'Invalid path' }, 400)

  // Owner check
  const ownerFilter = c.get('storageOwnerFilter')
  if (ownerFilter) {
    const userId = c.get('userId') as string | undefined
    const meta = await sql`SELECT uploaded_by FROM _ezbase_files WHERE path = ${fullPath}`
    if (meta.length === 0) return c.json({ error: 'File not found' }, 404)
    if (meta[0].uploaded_by !== userId) return c.json({ error: 'Forbidden' }, 403)
  }

  const rows = await sql`DELETE FROM _ezbase_files WHERE path = ${fullPath} RETURNING *`
  if (rows.length === 0) return c.json({ error: 'File not found' }, 404)

  try { await unlink(`${STORAGE_PATH}/${fullPath}`) } catch {}

  return c.json({ success: true })
})

// HEAD is handled automatically by Hono — GET handler sets Content-Type/Content-Length,
// and Hono strips the body for HEAD requests.

export { storageRoutes }
