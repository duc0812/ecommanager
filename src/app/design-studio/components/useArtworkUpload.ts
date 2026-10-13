'use client'
import { useCallback, useRef, useState } from 'react'
import type { ArtworkRow } from './types'

export const ARTWORK_ACCEPT = '.png,.jpg,.jpeg,.pdf,.psd,.zip,.tif,.tiff'

type UploadResult = { ok: true; data: { artwork?: ArtworkRow; warning?: string } } | { ok: false; error: string }

export function artworkUploadUrl(taskKey: string, printArea: string, fileName: string): string {
  const qs = new URLSearchParams({ printArea, fileName })
  return `/api/design-studio/tasks/${encodeURIComponent(taskKey)}/artwork?${qs}`
}

function putWithProgress(url: string, file: File, onProgress: (pct: number) => void): Promise<UploadResult> {
  return new Promise(resolve => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream')
    xhr.upload.onprogress = e => { if (e.lengthComputable && e.total > 0) onProgress(Math.min(100, Math.round((e.loaded / e.total) * 100))) }
    xhr.upload.onload = () => onProgress(100)
    xhr.onload = () => {
      let data: any = {}
      try { data = JSON.parse(xhr.responseText || '{}') } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve({ ok: true, data })
      else resolve({ ok: false, error: data?.error ?? `HTTP ${xhr.status}` })
    }
    xhr.onerror = () => resolve({ ok: false, error: 'Lỗi mạng' })
    xhr.onabort = () => resolve({ ok: false, error: 'Đã huỷ tải lên' })
    xhr.send(file)
  })
}

export function useArtworkUpload(taskKey: string, onUploaded: () => void) {
  const [progress, setProgress] = useState<Record<string, number>>({})
  const [warnings, setWarnings] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const busyRef = useRef(new Set<string>())

  const setWarning = useCallback((area: string, msg: string) => {
    setWarnings(w => {
      const next = { ...w }
      if (msg) next[area] = msg
      else delete next[area]
      return next
    })
  }, [])

  async function upload(printArea: string, file: File) {
    if (busyRef.current.has(printArea)) return
    busyRef.current.add(printArea)
    setProgress(p => ({ ...p, [printArea]: 0 })); setError(''); setWarning(printArea, '')
    const r = await putWithProgress(artworkUploadUrl(taskKey, printArea, file.name), file,
      pct => setProgress(p => ({ ...p, [printArea]: pct })))
    busyRef.current.delete(printArea)
    setProgress(p => { const next = { ...p }; delete next[printArea]; return next })
    if (!r.ok) { setError(`${printArea}: ${r.error}`); return }
    if (r.data.warning) setWarning(printArea, r.data.warning)
    onUploaded()
  }

  function busyLabel(pct: number) {
    return pct < 100 ? `Đang tải ${pct}%` : 'Đang lưu…'
  }

  return { progress, warnings, setWarning, error, setError, upload, busyLabel }
}
