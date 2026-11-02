'use client'
import { useEffect, useRef, useState } from 'react'
import type { TaskDetail } from './types'
import { areaSetHint, artworkImage, canRemoveArtwork, newestFor, printPartNames, versionsFor } from './model'
import TemplateCanvas, { CanvasTools, type CanvasArtActions, type CanvasBg, type CanvasUpload } from './TemplateCanvas'
import { ALL_GUIDES, GUIDES_STORAGE_KEY, parseGuides, type Guides } from './canvas-guides'
import { ARTWORK_ACCEPT, useArtworkUpload } from './useArtworkUpload'
import { useArtworkRemove } from './useArtworkRemove'
import { useLightbox } from './Lightbox'
import { useDismiss } from './overlay'
import AutoRenderBar from './AutoRenderBar'
import FileMenu from './FileMenu'
import { ErrorBanner, Icon, Note, btnTonal, card } from './ui'

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

const floatBtn = 'inline-grid place-items-center w-8 h-8 rounded-lg text-on-surface-variant hover:bg-surface-container-low hover:text-on-surface'

export default function ArtworkPanel({ detail, onChanged }: { detail: TaskDetail; onChanged: () => void }) {
  const { line, template, slots, me, task } = detail
  const [bg, setBg] = useState<CanvasBg>('checker')
  const [guide, setGuide] = useState(50)
  const [guides, setGuides] = useStoredGuides()
  const [pickedArea, setPickedArea] = useState('')
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [full, setFull] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const manyInput = useRef<HTMLInputElement>(null)
  const pending = useRef('')
  const chipsRef = useRef<HTMLDivElement>(null)
  useDismiss(chipsRef, menuFor !== null, () => setMenuFor(null))
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

      <div className="flex items-center gap-sm px-lg pt-sm">
        {template && (
          <div className="flex-1 min-w-0">
            <CanvasTools bg={bg} onBg={setBg} guide={guide} onGuide={setGuide} hasGuide={!!template.guideImageUrl} guides={guides} onGuides={setGuides} hasBleed={template.bleedIn > 0} />
          </div>
        )}
        <button type="button" onClick={() => setFull(!full)} aria-label={full ? 'Thu nhỏ' : 'Phóng to toàn màn'} title={full ? 'Thu nhỏ (Esc)' : 'Phóng to toàn màn'} className={`${floatBtn} ml-auto shrink-0`}>
          <Icon name={full ? 'close_fullscreen' : 'open_in_full'} className="text-[20px]" />
        </button>
      </div>
      <div className={`relative px-lg pt-sm pb-lg ${full ? 'flex-1' : ''}`}>
        <TemplateCanvas template={template} line={line} slots={slots} bg={bg} guide={guide} guides={guides} upload={canvasUpload} artActions={artActions}
          selected={targetArea} maxVh={full ? 80 : 62} />
      </div>
    </section>
  )
}
