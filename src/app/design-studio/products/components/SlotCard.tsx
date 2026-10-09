'use client'
import { useRef, useState, type DragEvent } from 'react'
import Link from 'next/link'
import { FIELD_FITS, normField, type ArtworkField, type FieldFit } from '@/lib/artwork-fields'
import type { LibraryEntryView, LibraryFontRow, LibrarySlot } from '@/lib/artwork-library-types'
import { LibraryCanvas, CanvasTools, type CanvasBg, type CanvasText } from '../../components/TemplateCanvas'
import { ALL_GUIDES, type Guides } from '../../components/canvas-guides'
import { requestJson } from '../../components/model'
import { ErrorBanner, Icon, Note, Pill, btn, btnPrimary, card, fmtSize, input } from '../../components/ui'
import { FONT_ACCEPT, psdUploadUrl, putFile, uploadFonts } from './upload'
import { LIBRARY_META, fmtDate, isBusy } from './meta'
import LayerFieldPicker from './LayerFieldPicker'

type View = 'compare' | 'preview' | 'artwork' | 'render'
type Draft = { field: string; fit: FieldFit; maxChars: string; x: string; y: string; w: string; h: string }

const VIEW_LABEL: Record<View, string> = { compare: 'So sánh', preview: 'PSD gốc', artwork: 'Artwork (không chữ)', render: 'Dựng lại chữ mẫu' }

function toDraft(f: ArtworkField): Draft {
  return { field: f.field, fit: f.fit, maxChars: f.maxChars ? String(f.maxChars) : '', x: String(f.box.x), y: String(f.box.y), w: String(f.box.w), h: String(f.box.h) }
}

function canvasBoxes(fields: ArtworkField[], withText: boolean): CanvasText[] {
  return fields.map((f, i) => ({
    key: `${f.layer}-${i}`, label: f.field, box: f.box,
    text: withText ? { value: f.sample || f.field, font: f.font, sizePx: f.sizePx, color: f.color, align: f.align, anchor: f.anchor, tracking: f.tracking, stroke: f.stroke } : undefined,
  }))
}

function hasFiles(e: DragEvent) {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files')
}

function SlotTitle({ slot, stale }: { slot: LibrarySlot; stale: boolean }) {
  const meta = LIBRARY_META[slot.status]
  return (
    <div className="flex flex-col gap-[2px] min-w-0">
      <div className="flex items-center gap-sm flex-wrap">
        <h3 className="text-body-md font-bold text-on-surface">{slot.title}</h3>
        <Pill tone={meta.tone} icon={meta.icon}>{meta.label}</Pill>
        {stale && <Pill tone="idle" icon="history">không còn dùng</Pill>}
      </div>
      <div className="flex items-center gap-xs flex-wrap text-label-sm text-on-surface-variant">
        <Icon name="factory" className="text-[16px]" />
        <b className="text-on-surface">{slot.supplier.name}</b>
        {slot.supplierSkus.length > 0 && <span>· SKU <span className="font-mono text-on-surface">{slot.supplierSkus.join(', ')}</span></span>}
        {slot.template && (
          <span>· template <b className="text-on-surface">{slot.template.name}</b> <span className="font-mono">{slot.template.widthPx}×{slot.template.heightPx} px · {slot.template.dpi} DPI</span></span>
        )}
        {slot.lineCount > 0 && <span>· {slot.lineCount} dòng đơn</span>}
      </div>
    </div>
  )
}

function SplitControl({ slot, productKey, onChanged }: { slot: LibrarySlot; productKey: string; onChanged: () => void }) {
  const [open, setOpen] = useState(false)
  const [choice, setChoice] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const template = slot.template
  if (!template) return null
  const tplName = template.name
  const tplId = template.id

  async function send(optionName: string | null) {
    if (busy) return
    setBusy(true); setError('')
    const r = await requestJson(`/api/design-studio/library/products/${encodeURIComponent(productKey)}/split`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ printTemplateId: tplId, optionName }),
    })
    setBusy(false)
    if (!r.ok) { setError(r.error); return }
    setOpen(false); setChoice('')
    onChanged()
  }

  if (slot.splitOption) {
    return (
      <div className="flex items-center gap-xs flex-wrap">
        <span className="text-label-sm text-on-surface-variant">Template này đang tách theo <b className="text-on-surface">{slot.splitOption}</b></span>
        <button type="button" className={btn} disabled={busy} onClick={() => void send(null)}
          aria-label={`Gộp lại các slot của template ${tplName}`}
          title="Gộp mọi giá trị về một artwork chung; artwork đã tách chuyển xuống mục Không còn dùng">
          <Icon name="call_merge" className="text-[16px]" />Gộp lại
        </button>
        {error && <span role="alert" className="text-label-sm text-error">{error}</span>}
      </div>
    )
  }
  if (slot.splitChoices.length === 0) return null
  return (
    <div className="flex items-center gap-xs flex-wrap">
      {!open ? (
        <button type="button" className={btn} onClick={() => setOpen(true)} title="Mỗi giá trị của option sẽ có một PSD riêng">
          <Icon name="call_split" className="text-[16px]" />Tách theo option
        </button>
      ) : (
        <>
          <label className="flex items-center gap-xs text-label-sm text-on-surface-variant">Tách theo
            <select className={input} value={choice} onChange={e => setChoice(e.target.value)} aria-label={`Option để tách template ${tplName}`}>
              <option value="">— chọn option —</option>
              {slot.splitChoices.map(c => <option key={c.name} value={c.name}>{c.name} ({c.values.length} giá trị: {c.values.join(', ')})</option>)}
            </select>
          </label>
          <button type="button" className={btnPrimary} disabled={!choice || busy} onClick={() => void send(choice)}>
            <Icon name="call_split" className="text-[16px]" />{busy ? 'Đang tách…' : 'Tách'}
          </button>
          <button type="button" className={btn} onClick={() => { setOpen(false); setChoice('') }}>Huỷ</button>
        </>
      )}
      {error && <span role="alert" className="text-label-sm text-error">{error}</span>}
    </div>
  )
}

export default function SlotCard({ slot, stale = false, product, fonts, canAdmin, onChanged }: {
  slot: LibrarySlot; stale?: boolean
  product: { key: string; storeId: string; shopifyProductId: string; observedFields: string[] }
  fonts: LibraryFontRow[]; canAdmin: boolean; onChanged: () => void
}) {
  const { template, entry } = slot
  const fileRef = useRef<HTMLInputElement>(null)
  const fontRef = useRef<HTMLInputElement>(null)
  const [upload, setUpload] = useState<{ pct: number; name: string } | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [bg, setBg] = useState<CanvasBg>('checker')
  const [guide, setGuide] = useState(50)
  const [guides, setGuides] = useState<Guides>({ ...ALL_GUIDES, areas: false })
  const [view, setView] = useState<View | null>(null)
  const [drafts, setDrafts] = useState<Draft[] | null>(null)
  const [notes, setNotes] = useState<string | null>(null)

  if (!template) {
    return (
      <section aria-label={`Slot ${slot.title} · ${slot.supplier.name} ${slot.supplierSkus.join(', ')}`} className={`${card} px-md py-sm flex flex-col gap-sm`}>
        <SlotTitle slot={slot} stale={stale} />
        <Note tone="warn" icon="dashboard_customize">
          Chưa có template cho SKU xưởng <span className="font-mono">{slot.supplierSkus.join(', ') || '(không SKU)'}</span> nên chưa upload PSD được.{' '}
          <Link href={`/setup/suppliers/${encodeURIComponent(slot.supplier.id)}/print-templates`} className="underline font-semibold">Tạo template cho {slot.supplier.name}</Link>
        </Note>
      </section>
    )
  }

  const tpl = template
  const uploadKey = stale ? (entry?.optionKey ?? '') : slot.optionKey
  const busyParse = isBusy(entry?.status)
  const fields = entry?.fields ?? []
  const parsed = !!entry?.parsedAt
  const hasArt = !!entry?.artwork
  const hasPreview = !!entry?.preview
  const defaultView: View = entry?.status === 'NEEDS_REVIEW' && hasArt && hasPreview ? 'compare' : hasPreview ? 'preview' : 'artwork'
  const shown: View = view && (view === 'compare' ? hasArt && hasPreview : view === 'preview' ? hasPreview : hasArt) ? view : defaultView
  const fontNames = new Set(fonts.map(f => f.postscriptName.toLowerCase()))
  const observed = new Set(product.observedFields.map(normField))
  const fieldNames = new Set(fields.map(f => normField(f.field)))
  const missingLayers = product.observedFields.filter(f => !fieldNames.has(normField(f)))

  async function sendPsd(file: File) {
    if (upload) return
    if (!/\.psd$/i.test(file.name)) { setError('Chỉ nhận file .psd'); return }
    setError(''); setInfo('')
    setUpload({ pct: 0, name: file.name })
    const r = await putFile<{ entry: LibraryEntryView; drive: boolean }>(psdUploadUrl(product.storeId, product.shopifyProductId, tpl.id, uploadKey, file.name), file, pct => setUpload({ pct, name: file.name }))
    setUpload(null)
    if (!r.ok) { setError(r.error); return }
    setInfo(r.data.drive ? 'Đã nhận PSD — đang đẩy lên Drive và chờ worker đọc.' : 'Đã nhận PSD — chờ worker đọc.')
    setDrafts(null)
    onChanged()
  }

  async function patch(body: Record<string, unknown>, done: string) {
    if (!entry || busy) return
    setBusy(true); setError(''); setInfo('')
    const r = await requestJson<{ entry: LibraryEntryView }>(`/api/design-studio/library/entries/${encodeURIComponent(entry.id)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    setBusy(false)
    if (!r.ok) { setError(r.error); return false }
    setInfo(done)
    onChanged()
    return true
  }

  async function saveFields() {
    if (!drafts) return
    const next: ArtworkField[] = []
    for (let i = 0; i < fields.length; i++) {
      const d = drafts[i]
      const box = { x: Number(d.x), y: Number(d.y), w: Number(d.w), h: Number(d.h) }
      if (!d.field.trim()) { setError(`Dòng ${i + 1}: tên trường bắt buộc`); return }
      if (Object.values(box).some(v => !Number.isFinite(v)) || box.w < 0 || box.h < 0) { setError(`Dòng ${i + 1}: khung không hợp lệ`); return }
      const max = d.maxChars.trim() ? Number(d.maxChars) : undefined
      if (max !== undefined && (!Number.isInteger(max) || max <= 0)) { setError(`Dòng ${i + 1}: max ký tự phải là số nguyên dương`); return }
      const f: ArtworkField = { ...fields[i], field: d.field.trim(), fit: d.fit, box }
      if (max !== undefined) f.maxChars = max
      else delete f.maxChars
      next.push(f)
    }
    if (await patch({ fields: next }, 'Đã lưu các trường')) setDrafts(null)
  }

  async function sendFonts(list: FileList | null) {
    const files = Array.from(list ?? [])
    if (files.length === 0) return
    setBusy(true); setError(''); setInfo('')
    const r = await uploadFonts(files, (name, pct) => setInfo(`Đang tải ${name} ${pct}%`))
    setBusy(false)
    if (r.errors.length) setError(r.errors.join(' · '))
    setInfo(r.done.length ? `Đã thêm font ${r.done.join(', ')}${r.requeued ? ` · đọc lại ${r.requeued} PSD` : ''}` : '')
    onChanged()
  }

  async function remove() {
    if (!entry || !window.confirm('Xoá entry này? File PSD vẫn được giữ.')) return
    setBusy(true)
    const r = await requestJson(`/api/design-studio/library/entries/${encodeURIComponent(entry.id)}`, { method: 'DELETE' })
    setBusy(false)
    if (!r.ok) { setError(r.error); return }
    onChanged()
  }

  const dropProps = {
    onDragOver: (e: DragEvent<HTMLDivElement>) => { if (!hasFiles(e)) return; e.preventDefault(); if (!dragOver) setDragOver(true) },
    onDragLeave: (e: DragEvent<HTMLDivElement>) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false) },
    onDrop: (e: DragEvent<HTMLDivElement>) => {
      if (!hasFiles(e)) return
      e.preventDefault(); setDragOver(false)
      const f = e.dataTransfer.files?.[0]
      if (f) void sendPsd(f)
    },
  }

  const canvas = (v: View) => {
    const url = v === 'preview' ? entry?.preview?.url ?? null : entry?.artwork?.url ?? null
    return <LibraryCanvas template={tpl} imageUrl={url} boxes={canvasBoxes(fields, v === 'render')} bg={bg} guide={guide} guides={guides} showBoxes={v !== 'preview' || fields.length > 0} />
  }

  return (
    <section aria-label={`Slot ${slot.title} · ${slot.supplier.name} · ${tpl.name}`} className={`${card} flex flex-col`}>
      <div className="flex items-start gap-sm flex-wrap px-md py-sm border-b border-outline-variant/20">
        <SlotTitle slot={slot} stale={stale} />
        {!stale && <div className="ml-auto"><SplitControl slot={slot} productKey={product.key} onChanged={onChanged} /></div>}
      </div>
      {tpl.areas.length > 0 && (
        <div className="px-md pt-sm flex flex-wrap gap-x-md gap-y-xs text-label-sm text-on-surface-variant">
          <span className="inline-flex items-center gap-xs"><Icon name="crop" className="text-[16px]" />{tpl.areas.map(a => `${a.name} ${a.w}×${a.h}`).join(' · ')}</span>
        </div>
      )}
      {slot.inherited && entry && (
        <div className="px-md pt-sm">
          <Note tone="idle" icon="link">
            Đang dùng artwork chung của template (trước khi tách). Upload PSD ở đây để <b>{slot.optionLabel ?? slot.title}</b> có artwork riêng.
          </Note>
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-md p-md">
        <div className="flex flex-col gap-sm min-w-0">
          {(hasArt || hasPreview) && (
            <div className="flex items-center gap-xs flex-wrap" role="group" aria-label="Chế độ xem">
              {(['compare', 'preview', 'artwork', 'render'] as View[]).filter(v => v === 'compare' ? hasArt && hasPreview : v === 'preview' ? hasPreview : hasArt).map(v => (
                <button key={v} type="button" aria-pressed={shown === v} onClick={() => setView(v)}
                  className={`rounded-full px-sm py-[2px] text-label-sm border ${shown === v ? 'bg-secondary text-on-secondary border-transparent font-semibold' : 'bg-surface-container-lowest border-outline-variant/40 text-on-surface-variant hover:bg-surface-container-low'}`}>
                  {VIEW_LABEL[v]}
                </button>
              ))}
            </div>
          )}
          {!hasArt && !hasPreview && canvas('artwork')}
          {(hasArt || hasPreview) && shown !== 'compare' && canvas(shown)}
          {shown === 'compare' && hasArt && hasPreview && (
            <div className="grid grid-cols-1 2xl:grid-cols-2 gap-sm">
              <div className="flex flex-col gap-xs"><span className="text-label-sm font-semibold text-on-surface-variant">PSD gốc</span>{canvas('preview')}</div>
              <div className="flex flex-col gap-xs"><span className="text-label-sm font-semibold text-on-surface-variant">Dựng lại với chữ mẫu</span>{canvas('render')}</div>
            </div>
          )}
          <CanvasTools bg={bg} onBg={setBg} guide={guide} onGuide={setGuide} hasGuide={!!tpl.guideImageUrl} guides={guides} onGuides={setGuides} hasBleed={tpl.bleedIn > 0} />
        </div>

        <div className="flex flex-col gap-sm min-w-0">
          <div {...dropProps}
            className={`rounded-lg border-2 border-dashed px-md py-md flex flex-col items-center gap-xs text-center ${dragOver ? 'border-secondary bg-secondary/5' : 'border-outline-variant/50 bg-surface-container-low'}`}>
            <Icon name="upload_file" className="text-[28px] text-on-surface-variant" />
            <button type="button" className={btnPrimary} disabled={!!upload} onClick={() => fileRef.current?.click()}>
              <Icon name="upload" className="text-[18px]" />{entry?.psd && !slot.inherited ? 'Upload PSD mới' : 'Upload PSD'}{slot.optionLabel ? ` cho ${slot.optionLabel}` : ''}
            </button>
            <input ref={fileRef} type="file" accept=".psd" className="hidden" aria-label={`Chọn file PSD cho ${slot.title}`}
              onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void sendPsd(f) }} />
            <span className="text-label-sm text-on-surface-variant">hoặc kéo thả file .psd vào đây · tối đa 1 GB</span>
            <span className="text-label-sm text-on-surface-variant">Layer chữ custom đặt tên <code className="font-mono text-secondary">@Tên trường</code> (vd <code className="font-mono text-secondary">@Custom Name</code>)</span>
            {upload && (
              <div className="w-full flex flex-col gap-[2px]" role="status" aria-live="polite">
                <span className="text-label-sm text-on-surface">{upload.name} · {upload.pct < 100 ? `Đang tải ${upload.pct}%` : 'Đang lưu…'}</span>
                <div className="h-1 w-full rounded-full bg-surface-container overflow-hidden" role="progressbar" aria-label="Tiến độ tải PSD" aria-valuemin={0} aria-valuemax={100} aria-valuenow={upload.pct}>
                  <div className="h-full bg-secondary transition-all" style={{ width: `${upload.pct}%` }} />
                </div>
              </div>
            )}
          </div>

          {entry?.psd && (
            <div className="flex items-center gap-xs flex-wrap text-label-sm text-on-surface-variant">
              <Icon name="description" className="text-[16px]" />
              <span className="font-mono text-on-surface break-all">{entry.psd.fileName}</span>
              <span>{fmtSize(entry.psd.size)} · {fmtDate(entry.psd.createdAt)}</span>
              {entry.psd.storage === 'DRIVE' && <Pill tone="ok" icon="cloud_done">Drive</Pill>}
            </div>
          )}

          {busyParse && (
            <Note tone="brand" icon="hourglass_top">
              {entry?.status === 'PARSING' ? 'Worker đang đọc PSD…' : 'Đang chờ worker đọc PSD (worker chạy trên máy designer).'}
              {entry?.job?.error && <div className="text-label-sm">Lần trước lỗi: {entry.job.error}</div>}
            </Note>
          )}
          {entry?.status === 'ERROR' && <Note tone="bad" icon="error">{entry.error ?? entry.job?.error ?? 'Đọc PSD lỗi'}</Note>}

          {entry && parsed && (
            <div className="flex flex-wrap items-center gap-xs text-label-sm text-on-surface-variant">
              <span>Đọc lúc {fmtDate(entry.parsedAt)}</span>
              {entry.checkScore !== null && (
                <Pill tone={entry.checkScore <= 6 ? 'ok' : 'warn'} icon="compare">độ lệch {entry.checkScore.toFixed(1)}</Pill>
              )}
              {entry.approvedAt && <span>· xác nhận {fmtDate(entry.approvedAt)}{entry.approvedByName ? ` bởi ${entry.approvedByName}` : ''}</span>}
            </div>
          )}

          {entry && entry.warnings.length > 0 && (
            <Note tone="warn" icon="warning">
              <ul className="list-disc pl-md">{entry.warnings.map(w => <li key={w}>{w}</li>)}</ul>
            </Note>
          )}

          {entry && entry.missingFonts.length > 0 && (
            <Note tone="warn" icon="font_download_off">
              <div className="flex flex-col gap-xs">
                <span>Thiếu font:</span>
                <div className="flex flex-wrap gap-xs">
                  {entry.missingFonts.map(f => <Pill key={f} tone={fontNames.has(f.toLowerCase()) ? 'ok' : 'warn'}>{f}{fontNames.has(f.toLowerCase()) ? ' ✓' : ''}</Pill>)}
                </div>
                <div>
                  <button type="button" className={btn} disabled={busy} onClick={() => fontRef.current?.click()}><Icon name="font_download" className="text-[16px]" />Tải font</button>
                  <input ref={fontRef} type="file" accept={FONT_ACCEPT} multiple className="hidden" aria-label="Chọn file font"
                    onChange={e => { const l = e.target.files; void sendFonts(l).then(() => { if (fontRef.current) fontRef.current.value = '' }) }} />
                </div>
              </div>
            </Note>
          )}

          {entry && parsed && missingLayers.length > 0 && (
            <Note tone="warn" icon="layers_clear">
              {missingLayers.map(f => <span key={f} className="mr-sm">Thiếu layer <code className="font-mono">@{f}</code></span>)}
            </Note>
          )}

          {entry && (
            <div className="flex flex-wrap items-center gap-xs">
              {entry.status === 'NEEDS_REVIEW' && (
                <button type="button" className={btnPrimary} disabled={busy} onClick={() => void patch({ approve: true }, 'Đã xác nhận dùng')}>
                  <Icon name="verified" className="text-[18px]" />Xác nhận dùng
                </button>
              )}
              {entry.psd && (
                <button type="button" className={btn} disabled={busy || busyParse} onClick={() => void patch({ reparse: true }, 'Đã xếp hàng đọc lại')}>
                  <Icon name="refresh" className="text-[16px]" />Đọc lại PSD
                </button>
              )}
              {entry.psd && <a className={btn} href={`${entry.psd.url}?download=1`}><Icon name="download" className="text-[16px]" />Tải PSD</a>}
              {entry.psd?.driveWebViewLink && <a className={btn} href={entry.psd.driveWebViewLink} target="_blank" rel="noreferrer"><Icon name="open_in_new" className="text-[16px]" />Drive</a>}
              {canAdmin && <button type="button" className={`${btn} ml-auto`} disabled={busy} onClick={() => void remove()}><Icon name="delete" className="text-[16px]" />Xoá</button>}
            </div>
          )}

          {entry && (
            <label className="flex flex-col gap-[2px] text-label-sm text-on-surface-variant">Ghi chú
              <span className="flex gap-xs">
                <input className={`${input} flex-1`} value={notes ?? entry.notes ?? ''} onChange={e => setNotes(e.target.value)} placeholder="vd: chữ cong ở mặt sau" />
                {notes !== null && notes !== (entry.notes ?? '') && (
                  <button type="button" className={btn} disabled={busy} onClick={() => void patch({ notes }, 'Đã lưu ghi chú').then(ok => { if (ok) setNotes(null) })}>Lưu</button>
                )}
              </span>
            </label>
          )}

          {info && <span role="status" className="text-label-sm text-on-surface-variant">{info}</span>}
          <ErrorBanner msg={error} onClose={() => setError('')} />
        </div>
      </div>

      {entry && parsed && (
        <LayerFieldPicker entry={entry} observedFields={product.observedFields} disabled={busy || busyParse}
          onSave={layerFields => patch({ layerFields }, 'Đã lưu layer custom — đang đọc lại PSD')} />
      )}

      {entry && fields.length > 0 && (
        <div className="border-t border-outline-variant/20 overflow-x-auto">
          <div className="flex items-center gap-sm px-md py-xs">
            <b className="text-label-sm text-on-surface">Trường custom ({fields.length})</b>
            {entry.fixedTexts.length > 0 && <span className="text-label-sm text-on-surface-variant">· {entry.fixedTexts.length} layer chữ cố định</span>}
            <span className="ml-auto flex gap-xs">
              {drafts ? (
                <>
                  <button type="button" className={btn} onClick={() => setDrafts(null)}>Huỷ</button>
                  <button type="button" className={btnPrimary} disabled={busy} onClick={() => void saveFields()}><Icon name="save" className="text-[16px]" />Lưu trường</button>
                </>
              ) : (
                <button type="button" className={btn} disabled={busyParse} onClick={() => setDrafts(fields.map(toDraft))}><Icon name="edit" className="text-[16px]" />Sửa trường</button>
              )}
            </span>
          </div>
          <table className="w-full border-collapse text-body-sm">
            <thead>
              <tr className="text-label-sm text-on-surface-variant text-left border-y border-outline-variant/20">
                <th className="px-md py-xs font-medium">Trường</th>
                <th className="px-sm py-xs font-medium">Layer</th>
                <th className="px-sm py-xs font-medium">Font</th>
                <th className="px-sm py-xs font-medium text-right">Size</th>
                <th className="px-sm py-xs font-medium">Màu</th>
                <th className="px-sm py-xs font-medium">Căn</th>
                <th className="px-sm py-xs font-medium">Fit</th>
                <th className="px-sm py-xs font-medium">Max ký tự</th>
                {drafts && <th className="px-md py-xs font-medium">Khung (x, y, w, h)</th>}
              </tr>
            </thead>
            <tbody>
              {fields.map((f, i) => {
                const d = drafts?.[i]
                const set = (patchD: Partial<Draft>) => setDrafts(list => list ? list.map((x, j) => (j === i ? { ...x, ...patchD } : x)) : list)
                const fontKnown = !f.font || fontNames.has(f.font.toLowerCase())
                return (
                  <tr key={`${f.layer}-${i}`} className="border-b border-outline-variant/20 last:border-b-0 align-top">
                    <td className="px-md py-xs">
                      {d ? <input className={`${input} w-40`} value={d.field} onChange={e => set({ field: e.target.value })} aria-label={`Tên trường ${i + 1}`} /> : <b className="text-on-surface">{f.field}</b>}
                      {observed.size > 0 && !observed.has(normField(d?.field ?? f.field)) && <div><Pill tone="warn" icon="help">Khách không có trường này</Pill></div>}
                    </td>
                    <td className="px-sm py-xs font-mono text-label-sm text-on-surface-variant">{f.layer}</td>
                    <td className="px-sm py-xs font-mono text-label-sm">
                      <span className={fontKnown ? 'text-on-surface' : 'text-error'} title={fontKnown ? undefined : 'Chưa có trong thư viện font'}>{f.font || '—'}</span>
                    </td>
                    <td className="px-sm py-xs text-right">{Math.round(f.sizePx)}px</td>
                    <td className="px-sm py-xs">
                      <span className="inline-flex items-center gap-xs font-mono text-label-sm">
                        <i className="inline-block w-3.5 h-3.5 rounded border border-outline-variant/40" style={{ background: f.color }} />{f.color}
                      </span>
                      {f.stroke && <div className="text-label-sm text-on-surface-variant">viền {f.stroke.px}px {f.stroke.color}</div>}
                      {f.gradient && <div className="text-label-sm text-on-surface-variant">gradient {f.gradient.stops.length} màu</div>}
                      {f.bevel && <div className="text-label-sm text-on-surface-variant">bevel {f.bevel.size}px</div>}
                      {f.shadow && <div className="text-label-sm text-on-surface-variant">đổ bóng {f.shadow.blur}px</div>}
                    </td>
                    <td className="px-sm py-xs">{f.align}</td>
                    <td className="px-sm py-xs">
                      {d ? (
                        <select className={input} value={d.fit} onChange={e => set({ fit: e.target.value as FieldFit })} aria-label={`Fit ${f.field}`}>
                          {FIELD_FITS.map(x => <option key={x} value={x}>{x}</option>)}
                        </select>
                      ) : f.fit}
                    </td>
                    <td className="px-sm py-xs">
                      {d ? <input className={`${input} w-16`} type="number" min={1} value={d.maxChars} onChange={e => set({ maxChars: e.target.value })} aria-label={`Max ký tự ${f.field}`} /> : (f.maxChars ?? '—')}
                    </td>
                    {d && (
                      <td className="px-md py-xs">
                        <span className="flex gap-[2px]">
                          {(['x', 'y', 'w', 'h'] as const).map(k => (
                            <input key={k} className={`${input} w-16`} type="number" value={d[k]} onChange={e => set({ [k]: e.target.value })} aria-label={`${k} ${f.field}`} />
                          ))}
                        </span>
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
