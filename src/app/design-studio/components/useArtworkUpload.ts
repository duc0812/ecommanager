'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ArtworkRow, FileKind } from './types'

export const ARTWORK_ACCEPT = '.png,.jpg,.jpeg,.pdf,.psd,.zip,.tif,.tiff'
export const MOCKUP_ACCEPT = '.png,.jpg,.jpeg'

type UploadResult = { ok: true; data: { artwork?: ArtworkRow; warning?: string } } | { ok: false; error: string }

export type UploadState = 'queued' | 'uploading' | 'done' | 'error'
export type UploadItem = { id: number; name: string; kind: FileKind; part: string | null; pct: number; state: UploadState; error?: string }
/** Without `printArea` the server reads the part from the file name. */
export type UploadOptions = { kind?: FileKind; printArea?: string }

export function artworkUploadUrl(taskKey: string, printArea: string, fileName: string, kind: FileKind = 'PRINT'): string {
  const qs = new URLSearchParams()
  if (printArea) qs.set('printArea', printArea)
  qs.set('fileName', fileName)
  qs.set('kind', kind)
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

const isActive = (i: UploadItem) => i.state === 'queued' || i.state === 'uploading'

export function busyLabel(pct: number) {
  return pct < 100 ? `Đang tải ${pct}%` : 'Đang lưu…'
}

export function uploadItemLabel(i: UploadItem): string {
  if (i.state === 'queued') return 'Chờ tải'
  if (i.state === 'uploading') return busyLabel(i.pct)
  if (i.state === 'done') return 'Đã lưu'
  return i.error ?? 'Lỗi'
}

/**
 * Uploads any number of files, one after another, through the streamed route. Every file keeps its own progress and its own
 * error; one failure does not stop the files behind it.
 */
export function useArtworkUpload(taskKey: string, onUploaded: () => void) {
  const [items, setItems] = useState<UploadItem[]>([])
  const [warnings, setWarnings] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const chain = useRef<Promise<void>>(Promise.resolve())
  const seq = useRef(0)
  const itemsRef = useRef<UploadItem[]>([])
  const uploaded = useRef(onUploaded)
  useEffect(() => { uploaded.current = onUploaded }, [onUploaded])

  const update = useCallback((fn: (list: UploadItem[]) => UploadItem[]) => {
    itemsRef.current = fn(itemsRef.current)
    setItems(itemsRef.current)
  }, [])
  const patch = useCallback((id: number, change: Partial<UploadItem>) => update(list => list.map(i => (i.id === id ? { ...i, ...change } : i))), [update])

  const setWarning = useCallback((area: string, msg: string) => {
    setWarnings(w => {
      const next = { ...w }
      if (msg) next[area] = msg
      else delete next[area]
      return next
    })
  }, [])

  const uploadFiles = useCallback((files: File[], opts: UploadOptions = {}) => {
    if (files.length === 0) return
    const kind = opts.kind ?? 'PRINT'
    const batch = files.map(file => ({ file, item: { id: ++seq.current, name: file.name, kind, part: opts.printArea ?? null, pct: 0, state: 'queued' as UploadState } }))
    setError('')
    if (opts.printArea) setWarning(opts.printArea, '')
    update(list => [...list.filter(i => i.state !== 'done'), ...batch.map(b => b.item)])
    chain.current = chain.current.then(async () => {
      for (const { file, item } of batch) {
        patch(item.id, { state: 'uploading' })
        const r = await putWithProgress(artworkUploadUrl(taskKey, opts.printArea ?? '', file.name, kind), file, pct => patch(item.id, { pct }))
        if (!r.ok) {
          patch(item.id, { state: 'error', error: r.error })
          setError(`${file.name}: ${r.error}`)
          continue
        }
        const part = r.data.artwork?.printArea ?? item.part
        patch(item.id, { state: 'done', pct: 100, part })
        if (r.data.warning && part) setWarning(part, r.data.warning)
        uploaded.current()
      }
    })
  }, [taskKey, patch, update, setWarning])

  const active = items.filter(isActive)
  const progress: Record<string, number> = {}
  for (const i of active) if (i.kind === 'PRINT' && i.part && progress[i.part] === undefined) progress[i.part] = i.pct

  /** One file for one named part (a template area, or a part being replaced). Ignored while that part is still uploading. */
  function upload(printArea: string, file: File, kind: FileKind = 'PRINT') {
    if (itemsRef.current.some(i => isActive(i) && i.kind === kind && i.part === printArea)) return
    uploadFiles([file], { kind, printArea })
  }

  function dismiss(id: number) {
    update(list => list.filter(i => i.id !== id || isActive(i)))
  }

  return { items, active, busy: active.length > 0, progress, warnings, setWarning, error, setError, upload, uploadFiles, dismiss, busyLabel }
}
