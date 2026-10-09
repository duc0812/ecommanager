'use client'
import { useCallback, useRef, useState } from 'react'
import type { ArtworkRow } from './types'

export const ARTWORK_ACCEPT = '.png,.jpg,.jpeg,.pdf,.psd,.zip'

type UploadResult = { ok: true; data: { artwork?: ArtworkRow; warning?: string } } | { ok: false; error: string }

function postWithProgress(url: string, body: FormData, onProgress: (pct: number) => void): Promise<UploadResult> {
  return new Promise(resolve => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', url)
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
    xhr.send(body)
  })
}

export function useArtworkUpload(lineId: string, driveConnected: boolean, onUploaded: () => void) {
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
    const fd = new FormData()
    fd.set('printArea', printArea)
    fd.set('file', file)
    const r = await postWithProgress(`/api/design-studio/lines/${encodeURIComponent(lineId)}/artwork`, fd,
      pct => setProgress(p => ({ ...p, [printArea]: pct })))
    busyRef.current.delete(printArea)
    setProgress(p => { const next = { ...p }; delete next[printArea]; return next })
    if (!r.ok) { setError(`${printArea}: ${r.error}`); return }
    if (r.data.warning) setWarning(printArea, r.data.warning)
    onUploaded()
  }

  function busyLabel(pct: number) {
    if (pct < 100) return `Đang tải ${pct}%`
    return driveConnected ? 'Đang đẩy lên Drive…' : 'Đang lưu…'
  }

  return { progress, warnings, setWarning, error, setError, upload, busyLabel }
}
