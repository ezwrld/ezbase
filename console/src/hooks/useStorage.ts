import { useState, useEffect, useCallback } from 'react'

export interface FileMeta {
  path: string
  bucket: string
  filename: string
  size: number
  mimeType: string
  uploadedBy: string | null
  created: number
  updated: number
  url: string
}

export function useStorage(adminKey: string) {
  const [buckets, setBuckets] = useState<string[]>([])
  const [files, setFiles] = useState<FileMeta[]>([])
  const [selectedBucket, setSelectedBucket] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const headers = useCallback(() => {
    return { Authorization: `Bearer ${adminKey}` }
  }, [adminKey])

  const refreshBuckets = useCallback(async () => {
    try {
      const res = await fetch('/api/storage', { headers: headers() })
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      const data: string[] = await res.json()
      setBuckets(data)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch buckets')
    }
  }, [adminKey, headers])

  const refreshFiles = useCallback(async (bucket: string) => {
    setLoading(true)
    try {
      const res = await fetch(`/api/storage/${encodeURIComponent(bucket)}`, { headers: headers() })
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      const data: FileMeta[] = await res.json()
      setFiles(data)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch files')
    } finally {
      setLoading(false)
    }
  }, [adminKey, headers])

  useEffect(() => {
    refreshBuckets()
  }, [refreshBuckets])

  useEffect(() => {
    if (selectedBucket) {
      refreshFiles(selectedBucket)
    } else {
      setFiles([])
    }
  }, [selectedBucket, refreshFiles])

  const selectBucket = useCallback((bucket: string | null) => {
    setSelectedBucket(bucket)
  }, [])

  const upload = useCallback(async (bucket: string, file: File, path?: string) => {
    const formData = new FormData()
    formData.append('file', file)

    const url = path
      ? `/api/storage/${encodeURIComponent(bucket)}/${path}`
      : `/api/storage/${encodeURIComponent(bucket)}`

    const res = await fetch(url, {
      method: 'POST',
      headers: headers(),
      body: formData,
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }))
      throw new Error(body.error || res.statusText)
    }
    const meta: FileMeta = await res.json()

    // Refresh bucket list and file list
    await refreshBuckets()
    if (selectedBucket === bucket) {
      await refreshFiles(bucket)
    }

    return meta
  }, [adminKey, headers, refreshBuckets, refreshFiles, selectedBucket])

  const deleteFile = useCallback(async (path: string) => {
    const res = await fetch(`/api/storage/${path}`, {
      method: 'DELETE',
      headers: headers(),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }))
      throw new Error(body.error || res.statusText)
    }

    // Refresh
    if (selectedBucket) {
      await refreshFiles(selectedBucket)
    }
    await refreshBuckets()
  }, [adminKey, headers, refreshFiles, refreshBuckets, selectedBucket])

  return {
    buckets,
    files,
    selectedBucket,
    selectBucket,
    loading,
    error,
    upload,
    deleteFile,
    refreshBuckets,
    refreshFiles,
  }
}
