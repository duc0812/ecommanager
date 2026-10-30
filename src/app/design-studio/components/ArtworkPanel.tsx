'use client'
import { useEffect, useRef, useState } from 'react'
import type { TaskDetail } from './types'
import { areaSetHint, artworkImage, canRemoveArtwork, newestFor, printPartNames, versionsFor } from './model'
import TemplateCanvas, { type CanvasArtActions, type CanvasBg, type CanvasUpload } from './TemplateCanvas'
import { ALL_GUIDES, GUIDES_STORAGE_KEY, NO_GUIDES, parseGuides, type Guides } from './canvas-guides'
import { ARTWORK_ACCEPT, useArtworkUpload } from './useArtworkUpload'
import { useArtworkRemove } from './useArtworkRemove'
import { useLightbox } from './Lightbox'
import { useDismiss } from './overlay'
import AutoRenderBar from './AutoRenderBar'
import FileMenu from './FileMenu'
import { ErrorBanner, Icon, Note, btnTonal, card, popover } from './ui'

function useStoredGuides(): [Guides, (g: Guides) => void] {
  const [guides, setGuides] = useState<Guides>(ALL_GUIDES)
  useEffect(() => {
    try { setGuides(parseGuides(window.localStorage.getItem(GUIDES_STORAGE_KEY))) } catch {}
  }, [])
  function save(g: Guides) {
    setGuides(g)
    try { window.localStorage.setItem(GUIDES_STORAGE_KEY, JSON.stringify(g)) } catch {}
  }
  return [guides, save]
}

const BG_NEXT: Record<CanvasBg, CanvasBg> = { checker: 'white', white: 'black', black: 'checker' }
const BG_META: Record<CanvasBg, { icon: string; label: string }> = {
  checker: { icon: 'grid_on', label: 'Nền ô cờ — bấm để đổi sang nền trắng' },
  white: { icon: 'light_mode', label: 'Nền trắng — bấm để đổi sang nền tối' },
  black: { icon: 'dark_mode', label: 'Nền tối — bấm để đổi sang nền ô cờ' },
}
const floatBtn = 'inline-grid place-items-center w-8 h-8 rounded-lg text-on-surface-variant hover:bg-surface-container-low hover:text-on-surface'

export default function ArtworkPanel({ detail, onChanged }: { detail: TaskDetail; onChanged: () => void }) {
  const { line, template, slots, me, task } = detail
  const [bg, setBg] = useState<CanvasBg>('checker')
  const [guide, setGuide] = useState(50)
  const [guides, setGuides] = useStoredGuides()
  const [pickedArea, setPickedArea] = useState('')
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [guidesOpen, setGuidesOpen] = useState(false)
  const [full, setFull] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const manyInput = useRef<HTMLInputElement>(null)
  const pending = useRef('')
  const chipsRef = useRef<HTMLDivElement>(null)
  const guidesRef = useRef<HTMLDivElement>(null)
  useDismiss(chipsRef, menuFor !== null, () => setMenuFor(null))
  useDismiss(guidesRef, guidesOpen, () => setGuidesOpen(false))
  const up = useArtworkUpload(task.taskKey, onChanged)
  const remover = useArtworkRemove(onChanged)
  const lightbox = useLightbox()

  useEffect(() => {
    if (!full) return
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setFull(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [full])

  const parts = printPartNames(line, slots)
  const hasSlots = slots.length > 0
  const targetArea = parts.includes(pickedArea) ? pickedArea : (slots.find(s => !newestFor(line, s)) ?? slots[0] ?? parts[0] ?? '')
  const uploading = up.active[0]
  const busy = uploading ? { area: uploading.part ?? uploading.name, pct: uploading.pct, label: up.busyLabel(uploading.pct), more: up.active.length - 1 } : null

  function pick(area: string) {
    pending.current = area
    if (parts.includes(area)) setPickedArea(area)
    fileInput.current?.click()
  }

  const canvasUpload: CanvasUpload = {
    onDrop: (area, files) => { if (area && files.length === 1) up.upload(area, files[0]); else up.uploadFiles(files, { kind: 'PRINT' }) },
    onReject: msg => up.setError(msg), onPick: pick, onPickMany: () => manyInput.current?.click(), fallbackArea: targetArea, busy,
  }
  const artActions: CanvasArtActions = {
    onView: a => lightbox?.open(a.url, artworkImage(a)),
    onRemove: remover.ask,
    canRemove: a => canRemoveArtwork(a, me, task.status),
  }

  const toggles: { k: keyof Guides; label: string; swatch: string; show: boolean }[] = [
    { k: 'areas', label: 'Vùng in', swatch: 'bg-outline/20 border border-outline-variant', show: true },
    { k: 'safe', label: `An toàn${template ? ` ${template.safeIn}″` : ''}`, swatch: 'border-t-2 border-dashed border-on-tertiary-container', show: true },
    { k: 'bleed', label: `Bleed${template ? ` ${template.bleedIn}″` : ''}`, swatch: 'border-t-2 border-dashed border-error', show: !!template && template.bleedIn > 0 },
    { k: 'guide', label: 'Artguide', swatch: 'bg-secondary/30', show: !!template?.guideImageUrl },
  ]
  const shown = toggles.filter(t => t.show)
  const allOff = shown.every(t => !guides[t.k])
  const uploadLabel = hasSlots || parts.length > 0 ? targetArea : ''

  return (
    <section id="canvas" aria-label="Artwork — file in trên template"
      className={`${card} ${full ? 'fixed inset-md z-[100] flex flex-col overflow-auto' : 'relative scroll-mt-[260px]'}`}>
      {remover.dialog}
      <input ref={fileInput} type="file" accept={ARTWORK_ACCEPT} hidden aria-label={`Chọn file cho ${targetArea || 'file in'}`}
        onChange={e => {
          const f = e.target.files?.[0]
          const area = pending.current || targetArea
          pending.current = ''
          if (f && area) up.upload(area, f)
          else if (f) up.uploadFiles([f], { kind: 'PRINT' })
          e.target.value = ''
        }} />
      <input ref={manyInput} type="file" accept={ARTWORK_ACCEPT} multiple hidden aria-label="Chọn nhiều file in"
        onChange={e => { const files = Array.from(e.target.files ?? []); e.target.value = ''; up.uploadFiles(files, { kind: 'PRINT' }) }} />

      <div ref={chipsRef} className="relative flex flex-wrap items-center gap-sm px-md py-sm border-b border-outline-variant/40">
        <span className="text-body-sm font-semibold text-on-surface mr-xs">Artwork</span>
        {parts.length === 0 && <span className="text-[13px] text-on-surface-variant">Chưa có vùng in</span>}
        {parts.map(part => {
          const versions = versionsFor(line, part)
          const has = versions.length > 0
          const sel = part === targetArea
          const pct = up.progress[part]
          return (
            <div key={part} className={`relative inline-flex items-center rounded-lg border ${sel ? 'border-secondary bg-secondary/10 text-secondary' : has ? 'border-outline-variant text-on-surface' : 'border-amber-300 bg-amber-50 text-amber-900'}`}>
              <button type="button" onClick={() => setPickedArea(part)} aria-pressed={sel} title={has ? `${part} · v${versions[0].version} · ${versions[0].fileName}` : `${part} — chưa có file`}
                className="inline-flex items-center gap-xs h-8 pl-sm pr-xs text-[13px] leading-[18px] font-medium">
                <Icon name={has ? 'check_circle' : 'radio_button_unchecked'} className={`text-[16px] ${has ? 'text-on-tertiary-container' : 'text-amber-600'}`} />
                {part}
                <span className={`text-label-sm ${has ? 'text-on-surface-variant' : 'font-semibold'}`}>{pct !== undefined ? `${pct}%` : has ? `v${versions[0].version}` : 'thiếu'}</span>
              </button>
              {has ? (
                <button type="button" onClick={() => setMenuFor(menuFor === part ? null : part)} aria-label={`Thao tác file ${part}`} aria-haspopup="menu" aria-expanded={menuFor === part}
                  className="inline-grid place-items-center w-7 h-7 mr-[2px] rounded-md text-on-surface-variant hover:bg-surface-container-low">
                  <Icon name="more_horiz" className="text-[18px]" />
                </button>
              ) : <span className="w-xs" />}
              {menuFor === part && has && (
                <FileMenu className="top-10 left-0" versions={versions} taskKey={task.taskKey} me={me} taskStatus={task.status} driveConnected={detail.driveConnected}
                  renamable={!slots.includes(part)} onReplace={f => up.upload(part, f)} onRemove={remover.ask} onChanged={onChanged} onClose={() => setMenuFor(null)} />
              )}
            </div>
          )
        })}
        <div className="flex-1" />
        <AutoRenderBar detail={detail} onChanged={onChanged} />
        {hasSlots || parts.length > 0 ? (
          <button type="button" disabled={up.progress[targetArea] !== undefined} onClick={() => pick(targetArea)} className={btnTonal}
            title="Upload vào vùng đang chọn (hoặc kéo thả thẳng vào vùng in)">
            <Icon name="upload" className="text-[18px]" />Upload<span className="font-medium opacity-80">→ {uploadLabel}</span>
          </button>
        ) : null}
        {!hasSlots && (
          <button type="button" disabled={up.busy} onClick={() => manyInput.current?.click()} className={btnTonal} title="Chọn một hoặc nhiều file — mỗi tên file là một file riêng">
            <Icon name="upload" className="text-[18px]" />{parts.length > 0 ? 'Thêm file in' : 'Upload file in'}
          </button>
        )}
      </div>

      {(up.error || Object.keys(up.warnings).length > 0) && (
        <div className="px-md pt-sm flex flex-col gap-xs">
          <ErrorBanner msg={up.error} onClose={() => up.setError('')} />
          {Object.entries(up.warnings).map(([area, msg]) => <Note key={area} tone="warn" icon="cloud_off">{area}: {msg}</Note>)}
          {areaSetHint(template) && <Note tone="brand" icon="alt_route">{areaSetHint(template)}</Note>}
        </div>
      )}

      <div className={`relative px-lg pt-[60px] pb-lg ${full ? 'flex-1' : ''}`}>
        <div ref={guidesRef} className="absolute top-sm right-sm z-20 flex items-center gap-[2px] p-xs rounded-lg bg-surface-container-lowest border border-outline-variant/60 shadow-card">
          {template && (
            <>
              <button type="button" onClick={() => setBg(BG_NEXT[bg])} aria-label={BG_META[bg].label} title={BG_META[bg].label} className={floatBtn}>
                <Icon name={BG_META[bg].icon} className="text-[20px]" />
              </button>
              <button type="button" onClick={() => setGuidesOpen(!guidesOpen)} aria-label="Hiển thị vùng in, an toàn, bleed, artguide" aria-haspopup="menu" aria-expanded={guidesOpen}
                title="Vùng in · An toàn · Bleed · Artguide" className={`${floatBtn} w-auto px-xs`}>
                <Icon name="layers" className="text-[20px]" /><Icon name="expand_more" className="text-[16px]" />
              </button>
              <span className="w-px h-5 bg-outline-variant mx-[2px]" />
            </>
          )}
          <button type="button" onClick={() => setFull(!full)} aria-label={full ? 'Thu nhỏ' : 'Phóng to toàn màn'} title={full ? 'Thu nhỏ (Esc)' : 'Phóng to toàn màn'} className={floatBtn}>
            <Icon name={full ? 'close_fullscreen' : 'open_in_full'} className="text-[20px]" />
          </button>
          {guidesOpen && template && (
            <div role="menu" aria-label="Hiển thị hướng dẫn" className={`${popover} top-11 right-0 w-[260px] p-sm flex flex-col gap-xs text-body-sm text-on-surface`}>
              {shown.map(t => (
                <label key={t.k} className="flex items-center gap-sm h-9 px-xs rounded-lg cursor-pointer hover:bg-surface-container-low">
                  <input type="checkbox" checked={guides[t.k]} onChange={() => setGuides({ ...guides, [t.k]: !guides[t.k] })} className="w-[18px] h-[18px] accent-secondary" />
                  <span className={`inline-block w-4 h-3 ${t.swatch}`} />
                  <span className="flex-1">{t.label}</span>
                </label>
              ))}
              {template.guideImageUrl && guides.guide && (
                <label className="flex flex-col gap-xs px-xs text-label-sm text-on-surface-variant">Độ mờ artguide · {guide}%
                  <input type="range" min={0} max={100} value={guide} onChange={e => setGuide(Number(e.target.value))} className="accent-secondary" aria-label="Độ mờ artguide" />
                </label>
              )}
              <div role="separator" className="h-px my-xs bg-outline-variant/60" />
              <label className="flex items-center gap-sm h-9 px-xs rounded-lg cursor-pointer hover:bg-surface-container-low">
                <input type="checkbox" checked={allOff} onChange={() => setGuides(allOff ? ALL_GUIDES : NO_GUIDES)} className="w-[18px] h-[18px] accent-secondary" />
                <span>Chỉ xem artwork</span>
              </label>
            </div>
          )}
        </div>
        <TemplateCanvas template={template} line={line} slots={slots} bg={bg} guide={guide} guides={guides} upload={canvasUpload} artActions={artActions}
          selected={targetArea} maxVh={full ? 80 : 62} />
      </div>
    </section>
  )
}
