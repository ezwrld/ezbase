import { useState, useRef } from 'react'
import { Loader2, AlertCircle, Upload, Trash2, Download, Copy, Check, FolderOpen, File, Image } from 'lucide-react'
import { useStorage } from '@/hooks/useStorage'
import type { FileMeta } from '@/hooks/useStorage'

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString()
}

function isImage(mimeType: string): boolean {
  return mimeType.startsWith('image/')
}

export function StorageBrowser({ adminKey }: { adminKey: string }) {
  const { buckets, files, selectedBucket, selectBucket, loading, error, upload, deleteFile } = useStorage(adminKey)

  // Upload state
  const [uploadBucket, setUploadBucket] = useState('')
  const [uploadPath, setUploadPath] = useState('')
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Preview state
  const [previewFile, setPreviewFile] = useState<FileMeta | null>(null)

  // Copy state
  const [copiedPath, setCopiedPath] = useState<string | null>(null)

  // Delete confirm
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)

  async function handleUpload(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return
    const bucket = uploadBucket.trim()
    if (!bucket) {
      setUploadError('Bucket name is required')
      return
    }

    setUploading(true)
    setUploadError(null)
    try {
      for (const file of Array.from(fileList)) {
        await upload(bucket, file, uploadPath.trim() || undefined)
      }
      setUploadPath('')
      if (!selectedBucket) selectBucket(bucket)
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  async function handleDelete(path: string) {
    if (deleteConfirm !== path) {
      setDeleteConfirm(path)
      return
    }
    try {
      await deleteFile(path)
      setDeleteConfirm(null)
      if (previewFile?.path === path) setPreviewFile(null)
    } catch {}
  }

  function handleCopy(path: string) {
    const url = `${window.location.origin}/api/storage/${path}`
    navigator.clipboard.writeText(url)
    setCopiedPath(path)
    setTimeout(() => setCopiedPath(null), 2000)
  }

  if (error) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 py-20">
        <div className="flex items-center gap-2 text-sm text-red-500">
          <AlertCircle className="h-4 w-4" /> {error}
        </div>
      </div>
    )
  }

  const totalSize = files.reduce((sum, f) => sum + f.size, 0)

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-zinc-200 bg-white px-5 py-3">
        <div className="flex items-center gap-3">
          <h2 className="font-mono text-base font-semibold text-zinc-900">Storage</h2>
          {selectedBucket && (
            <span className="text-xs text-zinc-500">
              {files.length} file{files.length !== 1 ? 's' : ''} &middot; {formatSize(totalSize)}
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Bucket sidebar */}
        <div className="flex w-48 shrink-0 flex-col border-r border-zinc-200 bg-white">
          <div className="px-3 pb-2 pt-3 text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
            Buckets
          </div>

          {buckets.length === 0 && (
            <div className="px-3 py-2 text-xs text-zinc-400">No buckets yet</div>
          )}

          {buckets.map((b) => (
            <button
              key={b}
              onClick={() => selectBucket(b)}
              className={`flex items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
                selectedBucket === b
                  ? 'bg-sky-50 font-medium text-sky-600'
                  : 'text-zinc-600 hover:bg-zinc-50'
              }`}
            >
              <FolderOpen className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate font-mono">{b}</span>
            </button>
          ))}
        </div>

        {/* Main area */}
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Upload bar */}
          <div className="flex items-center gap-2 border-b border-zinc-200 bg-zinc-50 px-4 py-2">
            <input
              type="text"
              value={uploadBucket}
              onChange={(e) => setUploadBucket(e.target.value)}
              placeholder="Bucket"
              className="w-28 rounded border border-zinc-300 bg-white px-2 py-1 font-mono text-xs text-zinc-900 outline-none focus:border-sky-400"
            />
            <input
              type="text"
              value={uploadPath}
              onChange={(e) => setUploadPath(e.target.value)}
              placeholder="Path (optional)"
              className="w-40 rounded border border-zinc-300 bg-white px-2 py-1 font-mono text-xs text-zinc-900 outline-none focus:border-sky-400"
            />
            <input
              ref={fileInputRef}
              type="file"
              multiple
              onChange={(e) => handleUpload(e.target.files)}
              className="hidden"
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="flex items-center gap-1.5 rounded bg-sky-500 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-sky-600 disabled:opacity-50"
            >
              {uploading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />}
              Upload
            </button>
            {uploadError && <span className="text-xs text-red-500">{uploadError}</span>}
          </div>

          {/* File list */}
          <div className="flex-1 overflow-auto">
            {loading && (
              <div className="flex items-center justify-center py-20">
                <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />
              </div>
            )}

            {!loading && !selectedBucket && (
              <div className="flex items-center justify-center py-20 text-sm text-zinc-400">
                Select a bucket or upload a file
              </div>
            )}

            {!loading && selectedBucket && files.length === 0 && (
              <div className="flex items-center justify-center py-20 text-sm text-zinc-400">
                Bucket is empty
              </div>
            )}

            {!loading && files.length > 0 && (
              <table className="w-full text-left text-xs">
                <thead className="border-b border-zinc-200 bg-zinc-50 text-[10px] uppercase tracking-wider text-zinc-500">
                  <tr>
                    <th className="px-4 py-2 font-medium">File</th>
                    <th className="px-4 py-2 font-medium">Size</th>
                    <th className="px-4 py-2 font-medium">Type</th>
                    <th className="px-4 py-2 font-medium">Uploaded</th>
                    <th className="px-4 py-2 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100">
                  {files.map((f) => (
                    <tr key={f.path} className="hover:bg-zinc-50">
                      <td className="px-4 py-2">
                        <button
                          onClick={() => isImage(f.mimeType) ? setPreviewFile(f) : undefined}
                          className={`flex items-center gap-2 font-mono ${
                            isImage(f.mimeType) ? 'cursor-pointer text-sky-600 hover:underline' : 'text-zinc-900'
                          }`}
                        >
                          {isImage(f.mimeType) ? (
                            <Image className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
                          ) : (
                            <File className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
                          )}
                          <span className="truncate">{f.path.slice(f.bucket.length + 1)}</span>
                        </button>
                      </td>
                      <td className="px-4 py-2 text-zinc-500">{formatSize(f.size)}</td>
                      <td className="px-4 py-2 text-zinc-500">{f.mimeType}</td>
                      <td className="px-4 py-2 text-zinc-500">{formatDate(f.created)}</td>
                      <td className="px-4 py-2">
                        <div className="flex items-center gap-1">
                          <a
                            href={`/api/storage/${f.path}`}
                            download
                            className="rounded p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700"
                            title="Download"
                          >
                            <Download className="h-3.5 w-3.5" />
                          </a>
                          <button
                            onClick={() => handleCopy(f.path)}
                            className="rounded p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700"
                            title="Copy URL"
                          >
                            {copiedPath === f.path ? (
                              <Check className="h-3.5 w-3.5 text-emerald-500" />
                            ) : (
                              <Copy className="h-3.5 w-3.5" />
                            )}
                          </button>
                          <button
                            onClick={() => handleDelete(f.path)}
                            className={`rounded p-1 transition-colors ${
                              deleteConfirm === f.path
                                ? 'bg-red-50 text-red-600'
                                : 'text-zinc-400 hover:bg-zinc-100 hover:text-red-500'
                            }`}
                            title={deleteConfirm === f.path ? 'Click again to confirm' : 'Delete'}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Image preview */}
          {previewFile && isImage(previewFile.mimeType) && (
            <div className="border-t border-zinc-200 bg-white p-4">
              <div className="flex items-center justify-between pb-2">
                <span className="font-mono text-xs text-zinc-600">{previewFile.filename}</span>
                <button
                  onClick={() => setPreviewFile(null)}
                  className="text-xs text-zinc-400 hover:text-zinc-600"
                >
                  Close
                </button>
              </div>
              <img
                src={`/api/storage/${previewFile.path}`}
                alt={previewFile.filename}
                className="max-h-64 rounded border border-zinc-200 object-contain"
              />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
