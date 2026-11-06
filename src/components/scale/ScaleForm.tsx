'use client'
import { useRef, useState, type ChangeEvent, type DragEvent } from 'react'
import { shrinkImage } from '@/components/creative/GenerateForm'
import { scaleFileUrl, type ScaleTargetView } from '@/components/scale/types'

const ACCEPT = ['image/png', 'image/jpeg', 'image/webp']
const MAX_BYTES = 25 * 1024 * 1024

type Props = {
  targets: ScaleTargetView[]
  busy: boolean
  error: string | null
  onSubmit: (image: { dataUrl: string; name: string }, targetId: string) => Promise<void>
}

export function ScaleForm({ targets, busy, error, onSubmit }: Props) {
  const [image, setImage] = useState<{ dataUrl: string; name: string } | null>(null)
  const [targetId, setTargetId] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  async function take(file: File | undefined) {
    if (!file) return
    if (!ACCEPT.includes(file.type)) { setFileError('Chỉ nhận ảnh PNG, JPG, WEBP'); return }
    if (file.size > MAX_BYTES) { setFileError('Ảnh quá lớn (tối đa 25 MB)'); return }
    setFileError(null)
    setImage({ dataUrl: await shrinkImage(file), name: file.name })
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setDragOver(false)
    take(e.dataTransfer.files?.[0])
  }

  function onPick(e: ChangeEvent<HTMLInputElement>) {
    take(e.target.files?.[0])
    e.target.value = ''
  }

  const canSubmit = !busy && !!image && !!targetId

  return (
    <section className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest shadow-card">
      <div className="flex items-center gap-sm px-lg py-md border-b border-outline-variant/20">
        <span className="material-symbols-outlined text-secondary">swap_horiz</span>
        <h3 className="text-headline-sm text-primary">Scale sang sản phẩm khác</h3>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-lg p-lg">
        <div className="w-full max-w-[320px]">
          <p className="mb-xs text-label-sm text-on-surface-variant">1. Ảnh sản phẩm gốc</p>
          <div onDragOver={e => { e.preventDefault(); setDragOver(true) }} onDragLeave={() => setDragOver(false)} onDrop={onDrop} onClick={() => fileInput.current?.click()}
            className={`flex aspect-square cursor-pointer items-center justify-center overflow-hidden rounded-lg border-2 border-dashed ${dragOver ? 'border-secondary bg-secondary/5' : 'border-outline-variant/40 bg-surface'}`}>
            {image ? (
              <img src={image.dataUrl} alt={image.name} className="h-full w-full object-contain" />
            ) : (
              <div className="p-lg text-center text-body-sm text-on-surface-variant">
                <span className="material-symbols-outlined text-[32px]">upload</span>
                <p className="mt-xs">Kéo thả hoặc bấm để chọn 1 ảnh</p>
              </div>
            )}
            <input ref={fileInput} type="file" accept={ACCEPT.join(',')} hidden onChange={onPick} />
          </div>
          {image && <button type="button" onClick={() => setImage(null)} className="mt-xs text-body-sm text-secondary hover:underline">Bỏ ảnh</button>}
          {fileError && <p className="mt-xs text-body-sm text-error">{fileError}</p>}
        </div>

        <div className="flex flex-col">
          <p className="mb-xs text-label-sm text-on-surface-variant">2. Sản phẩm muốn scale sang</p>
          {targets.length === 0 ? (
            <div className="rounded-lg border border-dashed border-outline-variant/40 p-lg text-body-sm text-on-surface-variant">Chưa có sản phẩm đích nào sẵn sàng. Superadmin cần thêm ảnh phôi và bật sản phẩm ở tab Sản phẩm đích.</div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-md">
              {targets.map(t => (
                <button key={t.id} type="button" onClick={() => setTargetId(t.id)}
                  className={`overflow-hidden rounded-lg border-2 bg-surface text-left ${targetId === t.id ? 'border-secondary' : 'border-outline-variant/20 hover:border-outline-variant'}`}>
                  <img src={scaleFileUrl('targets', t.id, t.blankFile!, t.updatedAt)} alt={t.name} className="aspect-square w-full bg-white object-contain" />
                  <div className="p-sm">
                    <p className="text-label-sm text-on-surface-variant">{t.sku}</p>
                    <p className="text-body-sm text-primary">{t.name}</p>
                  </div>
                </button>
              ))}
            </div>
          )}
          <div className="mt-lg flex flex-wrap items-center gap-md">
            <button type="button" disabled={!canSubmit} onClick={() => image && onSubmit(image, targetId)} className="bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md disabled:opacity-50">
              {busy ? 'Đang gửi…' : 'Tạo mockup'}
            </button>
            <p className="text-body-sm text-on-surface-variant">Mỗi lần ra 1 ảnh vuông, thường mất 1–3 phút.</p>
          </div>
          {error && <p className="mt-sm text-body-sm text-error">{error}</p>}
        </div>
      </div>
    </section>
  )
}
