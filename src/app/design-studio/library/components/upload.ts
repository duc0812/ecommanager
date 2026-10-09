'use client'

export type PutResult<T> = { ok: true; data: T } | { ok: false; error: string }

export const FONT_ACCEPT = '.ttf,.otf,.ttc'

export function putFile<T = any>(url: string, file: File, onProgress: (pct: number) => void): Promise<PutResult<T>> {
  return new Promise(resolve => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
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

export function psdUploadUrl(storeId: string, shopifyProductId: string, templateId: string, fileName: string): string {
  const q = new URLSearchParams({ storeId, productId: shopifyProductId.split('/').pop() ?? shopifyProductId, templateId, fileName })
  return `/api/design-studio/library/entries/upload?${q.toString()}`
}

export function fontUploadUrl(fileName: string): string {
  return `/api/design-studio/library/fonts/upload?${new URLSearchParams({ fileName }).toString()}`
}

export async function uploadFonts(files: File[], onProgress: (name: string, pct: number) => void) {
  const done: string[] = []
  const errors: string[] = []
  let requeued = 0
  for (const f of files) {
    const r = await putFile<{ fonts: { postscriptName: string }[]; requeued: number }>(fontUploadUrl(f.name), f, pct => onProgress(f.name, pct))
    if (r.ok) {
      done.push(...r.data.fonts.map(x => x.postscriptName))
      requeued += r.data.requeued
    } else {
      errors.push(`${f.name}: ${r.error}`)
    }
  }
  return { done, errors, requeued }
}
