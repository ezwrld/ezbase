import { useState, useEffect } from 'react'
import { Loader2, AlertCircle, Lock, Check } from 'lucide-react'
import { useRules } from '@/hooks/useRules'

export function RulesEditor({ adminKey }: { adminKey: string }) {
  const { data, loading, error, save } = useRules(adminKey)
  const [text, setText] = useState('')
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [jsonError, setJsonError] = useState<string | null>(null)

  useEffect(() => {
    if (data) {
      setText(JSON.stringify(data.rules, null, 2))
    }
  }, [data])

  function handleTextChange(value: string) {
    setText(value)
    setJsonError(null)
    setSaveStatus('idle')
    try {
      JSON.parse(value)
    } catch (err) {
      setJsonError(err instanceof Error ? err.message : 'Invalid JSON')
    }
  }

  async function handleSave() {
    setJsonError(null)
    setSaveError(null)
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(text)
    } catch (err) {
      setJsonError(err instanceof Error ? err.message : 'Invalid JSON')
      return
    }
    setSaveStatus('saving')
    try {
      await save(parsed)
      setSaveStatus('saved')
      setTimeout(() => setSaveStatus('idle'), 2000)
    } catch (err) {
      setSaveStatus('error')
      setSaveError(err instanceof Error ? err.message : 'Save failed')
    }
  }

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center py-20">
        <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />
      </div>
    )
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

  const isReadonly = data?.readonly ?? false

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-zinc-200 bg-white px-5 py-3">
        <div className="flex items-center gap-3">
          <h2 className="font-mono text-base font-semibold text-zinc-900">rules.json</h2>
          {isReadonly && (
            <span className="flex items-center gap-1 rounded bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700">
              <Lock className="h-3 w-3" /> Read-only
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {saveStatus === 'saved' && (
            <span className="flex items-center gap-1 text-xs text-emerald-600">
              <Check className="h-3 w-3" /> Saved
            </span>
          )}
          {saveStatus === 'error' && (
            <span className="text-xs text-red-500">{saveError}</span>
          )}
          {!isReadonly && (
            <button
              onClick={handleSave}
              disabled={saveStatus === 'saving' || !!jsonError}
              className="rounded bg-sky-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-sky-600 disabled:opacity-50"
            >
              {saveStatus === 'saving' ? 'Saving...' : 'Save'}
            </button>
          )}
        </div>
      </div>

      {/* Read-only banner */}
      {isReadonly && (
        <div className="border-b border-amber-200 bg-amber-50 px-5 py-2 text-xs text-amber-700">
          Rules managed via mounted file (read-only). Edit the file on the host to make changes.
        </div>
      )}

      {/* Editor */}
      <div className="flex-1 overflow-auto p-5">
        <textarea
          value={text}
          onChange={(e) => handleTextChange(e.target.value)}
          readOnly={isReadonly}
          spellCheck={false}
          className={`h-full w-full resize-none rounded border bg-white p-4 font-mono text-sm leading-relaxed text-zinc-900 outline-none ${
            jsonError
              ? 'border-red-300 focus:border-red-400 focus:ring-1 focus:ring-red-400'
              : 'border-zinc-300 focus:border-sky-400 focus:ring-1 focus:ring-sky-400'
          } ${isReadonly ? 'cursor-not-allowed bg-zinc-50 text-zinc-600' : ''}`}
        />
        {jsonError && (
          <p className="mt-2 text-xs text-red-500">{jsonError}</p>
        )}
      </div>
    </div>
  )
}
