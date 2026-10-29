/** Files Google will not resize for us (over ~40 MB) get a preview made here, in the browser, right after upload. */
export const PREVIEW_FROM_BYTES = 30 * 1024 * 1024
export const PREVIEW_MAX_PX = 2000

export function wantsPreview(file: File): boolean {
  return (file.type === 'image/png' || file.type === 'image/jpeg') && file.size >= PREVIEW_FROM_BYTES
}

/** A JPEG of the picture with its longest side at `maxPx`, or null when the browser cannot decode it. */
export async function makePreviewJpeg(file: File, maxPx = PREVIEW_MAX_PX): Promise<Blob | null> {
  if (typeof createImageBitmap !== 'function') return null
  let bitmap: ImageBitmap
  try {
    const probe = await createImageBitmap(file)
    const scale = Math.min(1, maxPx / Math.max(probe.width, probe.height))
    if (scale < 1) {
      const w = Math.max(1, Math.round(probe.width * scale)), h = Math.max(1, Math.round(probe.height * scale))
      probe.close()
      bitmap = await createImageBitmap(file, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' })
    } else {
      bitmap = probe
    }
  } catch {
    return null
  }
  try {
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(bitmap, 0, 0)
    return await new Promise<Blob | null>(resolve => canvas.toBlob(b => resolve(b), 'image/jpeg', 0.85))
  } finally {
    bitmap.close()
  }
}

export async function putPreview(artworkId: string, jpeg: Blob): Promise<boolean> {
  try {
    const res = await fetch(`/api/design-studio/artwork/${encodeURIComponent(artworkId)}/preview`, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: jpeg })
    return res.ok
  } catch {
    return false
  }
}
