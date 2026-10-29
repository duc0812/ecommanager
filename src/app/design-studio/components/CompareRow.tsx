'use client'
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { TaskDetail } from './types'
import { artworkImage, isImage, mockupFiles, versionsFor, type LightboxImage } from './model'
import { MOCKUP_ACCEPT, uploadItemLabel, useArtworkUpload, type UploadItem } from './useArtworkUpload'
import { useArtworkRemove } from './useArtworkRemove'
import { useLightbox } from './Lightbox'
import { useDismiss } from './overlay'
import FileMenu from './FileMenu'
import { ErrorBanner, Icon, btnTonal, btnText, card, iconBtn } from './ui'

function UploadList({ items, onDismiss }: { items: UploadItem[]; onDismiss: (id: number) => void }) {
  if (items.length === 0) return null
  return (
    <ul className="flex flex-col gap-xs px-sm pb-sm" aria-label="Tiến độ tải mockup">
      {items.map(i => {
        const active = i.state === 'queued' || i.state === 'uploading'
        return (
          <li key={i.id} className={`rounded-lg border px-sm py-xs flex flex-col gap-[2px] ${i.state === 'error' ? 'border-error/50 bg-error-container/40' : 'border-outline-variant/30'}`}>
            <span className="flex items-center gap-xs text-label-sm min-w-0">
              <Icon name={i.state === 'error' ? 'error' : i.state === 'done' ? 'check_circle' : 'upload'}
                className={`text-[15px] ${i.state === 'error' ? 'text-error' : i.state === 'done' ? 'text-on-tertiary-container' : 'text-on-surface-variant'}`} />
              <span className="font-semibold truncate text-on-surface">{i.name}</span>
              <span className={`ml-auto shrink-0 ${i.state === 'error' ? 'text-error' : 'text-on-surface-variant'}`} role={i.state === 'error' ? 'alert' : undefined}>{uploadItemLabel(i)}</span>
              {!active && (
                <button type="button" onClick={() => onDismiss(i.id)} aria-label={`Ẩn ${i.name}`} className="leading-none text-on-surface-variant hover:text-on-surface">
                  <Icon name="close" className="text-[15px]" />
                </button>
              )}
            </span>
            {active && (
              <div className="h-1 rounded-full bg-surface-container overflow-hidden" role="progressbar" aria-label={`Tiến độ tải ${i.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={i.pct}>
                <div className="h-full bg-secondary transition-all" style={{ width: `${i.pct}%` }} />
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function Cell({ n, title, sub, tip, right, children, footer }: { n: number; title: string; sub?: string; tip?: string; right?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className={`${card} min-w-0 flex flex-col`}>
      <div className="flex items-center gap-sm h-12 pl-md pr-sm">
        <span className="w-5 h-5 rounded-full bg-surface-container text-on-surface-variant text-[11px] leading-5 font-semibold text-center shrink-0">{n}</span>
        <span title={tip} className="text-body-sm font-semibold text-on-surface whitespace-nowrap">{title}</span>
        {sub && <span className="min-w-0 truncate text-label-sm text-on-surface-variant" title={sub}>{sub}</span>}
        <span className="ml-auto flex items-center gap-xs shrink-0">{right}</span>
      </div>
      <div className="relative h-[240px] mx-sm mb-sm rounded-lg overflow-hidden bg-surface-container-low">{children}</div>
      {footer}
    </div>
  )
}

function Shot({ img, onOpen }: { img: LightboxImage; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} aria-label={`Mở lớn: ${img.label}`} title={img.label} className="block w-full h-full cursor-zoom-in">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={img.url} alt={img.label} className="w-full h-full object-contain p-sm" loading="lazy" />
    </button>
  )
}

function Empty({ icon, text }: { icon: string; text: string }) {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-xs px-md text-center text-on-surface-variant">
      <Icon name={icon} className="text-[28px]" />
      <span className="text-body-sm font-medium">{text}</span>
    </div>
  )
}

function SideBySide({ left, leftTitle, right, onClose }: { left: LightboxImage | null; leftTitle: string; right: LightboxImage | null; onClose: () => void }) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const pane = (img: LightboxImage | null, title: string) => (
    <figure className="flex-1 min-w-0 flex flex-col gap-sm">
      <figcaption className="text-body-sm font-semibold text-white">{title}{img ? <span className="font-normal text-white/70"> · {img.label}</span> : null}</figcaption>
      <div className="flex-1 min-h-0 rounded-lg bg-white/5 grid place-items-center overflow-hidden">
        {img
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={img.url} alt={img.label} className="max-w-full max-h-full object-contain" />
          : <span className="text-body-sm text-white/70">Chưa có ảnh</span>}
      </div>
    </figure>
  )
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label="So sánh preview khách và mockup" className="fixed inset-0 z-[110] bg-black/85 p-lg flex flex-col gap-md" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="flex items-center">
        <span className="text-body-md font-semibold text-white">Soi {leftTitle.toLowerCase()} ↔ mockup từ file in</span>
        <button type="button" onClick={onClose} aria-label="Đóng" className="ml-auto inline-grid place-items-center w-10 h-10 rounded-lg text-white hover:bg-white/10"><Icon name="close" className="text-[24px]" /></button>
      </div>
      <div className="flex-1 min-h-0 flex gap-md">
        {pane(left, leftTitle)}
        {pane(right, 'Mockup từ file in')}
      </div>
    </div>,
    document.body,
  )
}

const FRONT = /front|trước|truoc|mat-?truoc|_f\b/i
const BACK = /back|sau|mat-?sau|_b\b/i

export default function CompareRow({ detail, onChanged }: { detail: TaskDetail; onChanged: () => void }) {
  const { line, task, me } = detail
  const lightbox = useLightbox()
  const up = useArtworkUpload(task.taskKey, onChanged)
  const remover = useArtworkRemove(onChanged)
  const mockInput = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [menu, setMenu] = useState(false)
  const [over, setOver] = useState(false)
  const [side, setSide] = useState<'front' | 'back'>('front')
  const [idx, setIdx] = useState(0)
  const [soi, setSoi] = useState(false)
  useDismiss(menuRef, menu, () => setMenu(false))

  const variant: LightboxImage | null = line.imageUrl
    ? { url: line.imageUrl, label: line.imageIsVariant === false ? 'Ảnh sản phẩm Shopify (variant không có ảnh riêng)' : line.imageIsVariant ? 'Mockup variant (Shopify)' : 'Ảnh Shopify (đơn đồng bộ trước — Nạp lại để biết ảnh variant)' }
    : null
  const preview: LightboxImage | null = line.previewUrl ? { url: line.previewUrl, label: 'Preview custom khách tạo lúc đặt hàng' } : null

  const mockups = mockupFiles(line).filter(isImage)
  const sided = mockups.some(m => FRONT.test(m.printArea)) && mockups.some(m => BACK.test(m.printArea))
  const shownMocks = sided ? mockups.filter(m => (side === 'front' ? !BACK.test(m.printArea) : BACK.test(m.printArea))) : mockups
  const cur = shownMocks[Math.min(idx, Math.max(0, shownMocks.length - 1))]
  const mockImg = cur ? artworkImage(cur) : null

  function addMockups(files: File[]) {
    const images = files.filter(f => /\.(png|jpe?g)$/i.test(f.name))
    if (images.length < files.length) up.setError('Mockup chỉ nhận ảnh PNG hoặc JPG')
    if (images.length) up.uploadFiles(images, { kind: 'MOCKUP' })
  }
  const dragHasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files')
  const open = (img: LightboxImage) => lightbox?.open(img.url, img)

  return (
    <section id="compare" aria-label="So sánh với đơn" className="flex flex-col gap-sm">
      {remover.dialog}
      <input ref={mockInput} type="file" accept={MOCKUP_ACCEPT} multiple hidden aria-label="Chọn ảnh mockup"
        onChange={e => { const files = Array.from(e.target.files ?? []); e.target.value = ''; addMockups(files) }} />
      <div className="flex items-center gap-sm">
        <span className="text-body-sm font-semibold text-on-surface">So sánh</span>
        <span className="text-label-sm text-on-surface-variant">bấm ảnh để mở lớn</span>
        <button type="button" className={`${btnText} ml-auto`} disabled={!preview && !variant && !mockImg} onClick={() => setSoi(true)}>
          <Icon name="compare" className="text-[18px]" />Soi preview khách ↔ mockup cỡ lớn
        </button>
      </div>
      <div className="grid grid-cols-3 gap-md">
        <Cell n={1} title="Mockup variant" sub={variant ? (line.imageIsVariant ? line.variantTitle ?? undefined : 'ảnh sản phẩm') : undefined} tip="Ảnh Shopify của biến thể khách mua">
          {variant ? <Shot img={variant} onOpen={() => open(variant)} /> : <Empty icon="hide_image" text="Không có ảnh variant — Nạp lại từ Shopify" />}
        </Cell>
        <Cell n={2} title="Preview khách" sub={preview ? 'lúc đặt hàng' : undefined} tip="Ảnh khách tạo trong customizer lúc đặt hàng"
          right={line.customerDesignLink && (
            <a href={line.customerDesignLink} target="_blank" rel="noreferrer" className="inline-flex items-center gap-[2px] text-[13px] font-medium text-secondary hover:underline whitespace-nowrap">
              Mở lại thiết kế<Icon name="open_in_new" className="text-[15px]" />
            </a>
          )}>
          {preview ? <Shot img={preview} onOpen={() => open(preview)} /> : <Empty icon="hide_image" text={line.customized ? 'Không có preview custom' : 'Non-custom — không có preview'} />}
        </Cell>
        <Cell n={3} title="Mockup từ file in" sub={mockups.length ? `${mockups.length} ảnh${cur ? ` · ${cur.printArea}` : ''}` : undefined} tip="Mockup dựng từ file in để QA với ① và ②"
          right={(
            <div ref={menuRef} className="relative flex items-center gap-xs">
              {sided && (
                <div role="group" aria-label="Mặt" className="inline-flex p-[2px] rounded-lg bg-surface-container-low">
                  {(['front', 'back'] as const).map(s => (
                    <button key={s} type="button" aria-pressed={side === s} onClick={() => { setSide(s); setIdx(0) }}
                      className={`h-7 px-sm rounded-md text-label-sm font-semibold ${side === s ? 'bg-surface-container-lowest text-on-surface shadow-card' : 'text-on-surface-variant'}`}>
                      {s === 'front' ? 'Trước' : 'Sau'}
                    </button>
                  ))}
                </div>
              )}
              {shownMocks.length > 1 && (
                <span className="flex items-center text-label-sm text-on-surface-variant">
                  <button type="button" onClick={() => setIdx((idx - 1 + shownMocks.length) % shownMocks.length)} aria-label="Mockup trước" className={`${iconBtn} w-6 h-6`}><Icon name="chevron_left" className="text-[18px]" /></button>
                  {Math.min(idx, shownMocks.length - 1) + 1}/{shownMocks.length}
                  <button type="button" onClick={() => setIdx((idx + 1) % shownMocks.length)} aria-label="Mockup sau" className={`${iconBtn} w-6 h-6`}><Icon name="chevron_right" className="text-[18px]" /></button>
                </span>
              )}
              {cur && (
                <>
                  <button type="button" onClick={() => mockInput.current?.click()} disabled={up.busy} aria-label="Tải thêm mockup" title="Tải thêm mockup (PNG/JPG)" className={iconBtn}><Icon name="upload" className="text-[18px]" /></button>
                  <button type="button" onClick={() => setMenu(!menu)} aria-label={`Thao tác mockup ${cur.printArea}`} aria-haspopup="menu" aria-expanded={menu} className={iconBtn}><Icon name="more_horiz" className="text-[18px]" /></button>
                  {menu && (
                    <FileMenu className="top-10 right-0" versions={versionsFor(line, cur.printArea, 'MOCKUP')} taskKey={task.taskKey} me={me} taskStatus={task.status}
                      driveConnected={detail.driveConnected} renamable onReplace={f => up.upload(cur.printArea, f, 'MOCKUP')} onRemove={remover.ask} onChanged={onChanged} onClose={() => setMenu(false)} />
                  )}
                </>
              )}
            </div>
          )}
          footer={<>
            {up.error && <div className="px-sm pb-sm"><ErrorBanner msg={up.error} onClose={() => up.setError('')} /></div>}
            <UploadList items={up.items} onDismiss={up.dismiss} />
          </>}>
          <div className={`h-full ${over ? 'outline outline-2 outline-secondary bg-secondary/10' : ''}`}
            onDragOver={e => { if (!dragHasFiles(e)) return; e.preventDefault(); if (!over) setOver(true) }}
            onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false) }}
            onDrop={e => { if (!dragHasFiles(e)) return; e.preventDefault(); setOver(false); addMockups(Array.from(e.dataTransfer.files ?? [])) }}>
            {mockImg ? <Shot img={mockImg} onOpen={() => open(mockImg)} /> : (
              <div className="h-full flex flex-col items-center justify-center gap-sm rounded-lg border-[1.5px] border-dashed border-outline px-md text-center text-on-surface-variant">
                <Icon name="add_photo_alternate" className="text-[28px]" />
                <span className="text-body-sm">Kéo thả mockup dựng từ file in vào đây</span>
                <button type="button" onClick={() => mockInput.current?.click()} disabled={up.busy} className={`${btnTonal} h-8`}>
                  <Icon name="upload" className="text-[16px]" />Tải mockup
                </button>
              </div>
            )}
          </div>
        </Cell>
      </div>
      {soi && <SideBySide left={preview ?? variant} leftTitle={preview ? 'Preview khách' : 'Mockup variant'} right={mockImg} onClose={() => setSoi(false)} />}
    </section>
  )
}
