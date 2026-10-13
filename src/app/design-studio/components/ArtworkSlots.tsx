'use client'
import { useRef, useState, type DragEvent, type FormEvent, type ReactNode } from 'react'
import type { ArtworkRow, FileKind, Me, TaskStatus, WorkspaceLine } from './types'
import { artworkImage, artworkShareLink, canRemoveArtwork, copyText, isImage, mockupFiles, patchJson, printPartNames, requestJson, taskUrl, versionsFor } from './model'
import { Card, ErrorBanner, Icon, Note, Pill, btn, fmtSize, input } from './ui'
import { ARTWORK_ACCEPT, MOCKUP_ACCEPT, uploadItemLabel, useArtworkUpload, type UploadItem } from './useArtworkUpload'
import { useArtworkRemove } from './useArtworkRemove'
import { useLightbox } from './Lightbox'
import { PART_MAX } from '@/lib/task-files'

const mini = 'inline-flex items-center gap-xs rounded-md border border-outline-variant/40 px-xs py-[2px] text-label-sm font-semibold text-on-surface hover:bg-surface-container-low disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap'

export function DriveFolderLink({ folderUrl, driveConnected, onCopied, compact = false }: {
  folderUrl: string | null | undefined; driveConnected: boolean; onCopied: (msg: string) => void; compact?: boolean
}) {
  if (!folderUrl) {
    return (
      <span className="inline-flex items-center gap-xs text-label-sm text-on-surface-variant">
        <Icon name={driveConnected ? 'create_new_folder' : 'cloud_off'} className="text-[16px]" />
        {driveConnected ? 'Chưa có thư mục Drive — tạo khi file đầu tiên lên Drive' : 'Chưa có thư mục Drive (Drive chưa kết nối)'}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-xs flex-wrap text-label-sm">
      {!compact && <span className="inline-flex items-center gap-xs font-semibold text-on-surface"><Icon name="folder" className="text-[16px] text-secondary" />Thư mục Drive</span>}
      <a href={folderUrl} target="_blank" rel="noreferrer" className={mini} aria-label="Mở thư mục Drive của task">
        <Icon name="open_in_new" className="text-[14px]" />Mở thư mục
      </a>
      <button type="button" className={mini} aria-label="Copy link thư mục Drive của task"
        onClick={async () => onCopied(await copyText(folderUrl) ? 'Đã chép link thư mục Drive' : 'Không chép được link')}>
        <Icon name="content_copy" className="text-[14px]" />Copy link
      </button>
    </span>
  )
}

function hasFiles(e: DragEvent) {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files')
}

function DropZone({ label, accept, multiple, onFiles, children }: { label: string; accept: string; multiple: boolean; onFiles: (files: File[]) => void; children: ReactNode }) {
  const [over, setOver] = useState(false)
  const ref = useRef<HTMLInputElement>(null)
  return (
    <>
      <input ref={ref} type="file" accept={accept} multiple={multiple} hidden aria-label={label}
        onChange={e => { const files = Array.from(e.target.files ?? []); e.target.value = ''; onFiles(files) }} />
      <div role="button" tabIndex={0} aria-label={label}
        onClick={() => ref.current?.click()}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ref.current?.click() } }}
        onDragOver={e => { if (!hasFiles(e)) return; e.preventDefault(); if (!over) setOver(true) }}
        onDragLeave={() => setOver(false)}
        onDrop={e => { if (!hasFiles(e)) return; e.preventDefault(); setOver(false); onFiles(Array.from(e.dataTransfer.files ?? [])) }}
        className={`rounded-lg border-[1.5px] border-dashed px-sm py-sm text-center text-label-sm cursor-pointer ${over ? 'border-secondary bg-secondary/10 text-secondary' : 'border-outline-variant text-on-surface-variant hover:bg-surface-container-low'}`}>
        {children}
      </div>
    </>
  )
}

export function UploadList({ items, onDismiss }: { items: UploadItem[]; onDismiss: (id: number) => void }) {
  if (items.length === 0) return null
  return (
    <ul className="flex flex-col gap-xs" aria-label="Tiến độ tải file">
      {items.map(i => {
        const active = i.state === 'queued' || i.state === 'uploading'
        return (
          <li key={i.id} className={`rounded-lg border px-sm py-xs flex flex-col gap-[2px] ${i.state === 'error' ? 'border-error/50 bg-error-container/40' : 'border-outline-variant/20'}`}>
            <span className="flex items-center gap-xs text-label-sm min-w-0">
              <Icon name={i.state === 'error' ? 'error' : i.state === 'done' ? 'check_circle' : 'upload'}
                className={`text-[15px] ${i.state === 'error' ? 'text-error' : i.state === 'done' ? 'text-on-tertiary-container' : 'text-on-surface-variant'}`} />
              <span className="font-semibold truncate text-on-surface">{i.name}</span>
              {i.kind === 'MOCKUP' && <Pill tone="idle">mockup</Pill>}
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

function Thumb({ v }: { v: ArtworkRow }) {
  const lightbox = useLightbox()
  if (isImage(v) && lightbox) {
    return (
      <button type="button" onClick={() => lightbox.open(v.url, artworkImage(v))} aria-label={`Xem ${v.printArea} v${v.version}`} title="Xem ảnh"
        className="w-10 h-10 rounded-md overflow-hidden bg-surface-container-low border border-outline-variant/20 hover:ring-2 hover:ring-secondary">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={v.previewUrl ?? v.url} alt="" className="w-full h-full object-contain" loading="lazy" />
      </button>
    )
  }
  return (
    <span className="w-10 h-10 rounded-md bg-surface-container-low grid place-items-center text-on-surface-variant">
      <Icon name={v.mimeType.startsWith('image/') ? 'image' : 'description'} className="text-[18px]" />
    </span>
  )
}

type RowActions = {
  taskKey: string; driveConnected: boolean; me: Me; taskStatus: TaskStatus
  busyPart: (kind: FileKind, part: string) => boolean
  onReplace: (kind: FileKind, part: string, file: File) => void
  onRemove: (a: ArtworkRow) => void
  onChanged: () => void
  onSay: (msg: string) => void
  onError: (msg: string) => void
}

function PartRow({ versions, renamable, actions }: { versions: ArtworkRow[]; renamable: boolean; actions: RowActions }) {
  const v = versions[0]
  const older = versions.slice(1)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(v.printArea)
  const [saving, setSaving] = useState(false)
  const [pushing, setPushing] = useState(false)
  const replaceInput = useRef<HTMLInputElement>(null)
  const isDrive = v.storage === 'DRIVE'
  const isMockup = v.kind === 'MOCKUP'
  const removable = canRemoveArtwork(v, actions.me, actions.taskStatus)
  const locked = actions.taskStatus === 'DONE'
  const busy = actions.busyPart(v.kind, v.printArea)

  async function rename(e: FormEvent) {
    e.preventDefault()
    const to = draft.trim()
    if (!to || to === v.printArea) { setEditing(false); return }
    setSaving(true)
    const r = await patchJson(taskUrl(actions.taskKey, '/parts'), { kind: v.kind, from: v.printArea, to })
    setSaving(false)
    if (!r.ok) { actions.onError(r.error); return }
    setEditing(false)
    actions.onChanged()
  }

  async function push() {
    if (pushing) return
    setPushing(true)
    const r = await requestJson(`/api/design-studio/artwork/${encodeURIComponent(v.id)}/push`, { method: 'POST' })
    setPushing(false)
    if (!r.ok) { actions.onError(`${v.printArea}: ${r.error}`); return }
    actions.onChanged()
  }

  return (
    <li className="rounded-lg border border-outline-variant/30 p-xs flex flex-col gap-xs">
      <div className="grid grid-cols-[40px_minmax(0,1fr)] gap-sm items-center">
        <Thumb v={v} />
        <div className="min-w-0 flex flex-col gap-[2px]">
          {editing ? (
            <form onSubmit={rename} className="flex items-center gap-xs">
              <input value={draft} onChange={e => setDraft(e.target.value)} maxLength={PART_MAX} autoFocus aria-label={`Tên mới cho ${v.printArea}`} className={`${input} flex-1 py-[2px] text-label-sm`} />
              <button type="submit" className={mini} disabled={saving}>{saving ? 'Đang lưu…' : 'Lưu'}</button>
              <button type="button" className={mini} disabled={saving} onClick={() => { setEditing(false); setDraft(v.printArea) }}>Huỷ</button>
            </form>
          ) : (
            <span className="flex items-center gap-xs min-w-0 flex-wrap">
              <span className="text-body-sm font-semibold text-on-surface break-all">{v.printArea}</span>
              {renamable && (
                <button type="button" onClick={() => { setDraft(v.printArea); setEditing(true) }} disabled={locked} aria-label={`Đổi tên ${v.printArea}`}
                  title={locked ? 'Task đã duyệt design — bấm "Sửa & gửi lại" trước khi đổi tên' : 'Đổi tên file (áp dụng cho mọi phiên bản)'}
                  className="text-on-surface-variant hover:text-secondary leading-none disabled:opacity-40">
                  <Icon name="edit" className="text-[15px]" />
                </button>
              )}
              <Pill tone="idle">v{v.version}</Pill>
              <Pill tone={isDrive ? 'ok' : 'warn'} icon={isDrive ? 'cloud_done' : 'dns'}>{isDrive ? 'Drive' : 'Server'}</Pill>
              {v.source === 'AUTO' && <Pill tone="brand" icon="auto_awesome">Tự động</Pill>}
            </span>
          )}
          <span className="text-label-sm text-on-surface-variant truncate" title={v.fileName}>
            {v.fileName} · {v.widthPx && v.heightPx ? `${v.widthPx}×${v.heightPx} · ` : ''}{fmtSize(v.size)} · {new Date(v.createdAt).toLocaleString('en-US')}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-xs flex-wrap">
        <input ref={replaceInput} type="file" accept={isMockup ? MOCKUP_ACCEPT : ARTWORK_ACCEPT} hidden aria-label={`Chọn file thay cho ${v.printArea}`}
          onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) actions.onReplace(v.kind, v.printArea, f) }} />
        <button type="button" className={mini} disabled={busy} onClick={() => replaceInput.current?.click()} aria-label={`Thay file ${v.printArea}`}
          title="Tải file mới — thành phiên bản tiếp theo, bản cũ giữ trong lịch sử">
          <Icon name="upload" className="text-[14px]" />{busy ? 'Đang tải…' : 'Thay file'}
        </button>
        <button type="button" className={mini} aria-label={`Copy link ${v.printArea}`}
          onClick={async () => actions.onSay(await copyText(artworkShareLink(v)) ? `Đã chép link ${isDrive ? 'Drive' : 'file'} ${v.printArea}` : 'Không chép được link')}>
          <Icon name="content_copy" className="text-[14px]" />Copy link
        </button>
        {isDrive && v.driveWebViewLink && (
          <a href={v.driveWebViewLink} target="_blank" rel="noreferrer" className={mini} aria-label={`Mở ${v.printArea} trên Drive`}>
            <Icon name="open_in_new" className="text-[14px]" />Mở trên Drive
          </a>
        )}
        {!isDrive && actions.driveConnected && (
          <button type="button" disabled={pushing} onClick={push} className={mini} aria-label={`Đẩy ${v.printArea} lên Drive`}>
            <Icon name="cloud_upload" className="text-[14px]" />{pushing ? 'Đang đẩy…' : 'Đẩy lên Drive'}
          </button>
        )}
        <a href={v.url} download={v.fileName} aria-label={`Tải ${v.printArea} ${v.fileName}`} title="Tải file" className={mini}>
          <Icon name="download" className="text-[14px]" />Tải
        </a>
        <button type="button" onClick={() => actions.onRemove(v)} disabled={!removable.ok} title={removable.why ?? `Xoá ${v.printArea} v${v.version}`}
          aria-label={`Xoá ${v.printArea} v${v.version}`} className={`${mini} text-error ml-auto`}>
          <Icon name="delete" className="text-[14px]" />Xoá
        </button>
      </div>
      {older.length > 0 && (
        <details className="text-label-sm text-on-surface-variant">
          <summary className="cursor-pointer select-none">{older.length} phiên bản cũ</summary>
          <ul className="mt-xs flex flex-col gap-[2px]">
            {older.map(o => {
              const can = canRemoveArtwork(o, actions.me, actions.taskStatus)
              return (
                <li key={o.id} className="flex items-center gap-xs min-w-0">
                  <span className="font-semibold text-on-surface">v{o.version}</span>
                  <span className="truncate flex-1" title={o.fileName}>{o.fileName} · {fmtSize(o.size)} · {new Date(o.createdAt).toLocaleString('en-US')}</span>
                  <Pill tone={o.storage === 'DRIVE' ? 'ok' : 'warn'}>{o.storage === 'DRIVE' ? 'Drive' : 'Server'}</Pill>
                  <a href={o.url} download={o.fileName} aria-label={`Tải ${o.printArea} v${o.version}`} title="Tải file" className="hover:text-secondary"><Icon name="download" className="text-[16px]" /></a>
                  <button type="button" onClick={() => actions.onRemove(o)} disabled={!can.ok} title={can.why ?? `Xoá ${o.printArea} v${o.version}`}
                    aria-label={`Xoá ${o.printArea} v${o.version}`} className="text-error disabled:opacity-40"><Icon name="delete" className="text-[16px]" /></button>
                </li>
              )
            })}
          </ul>
        </details>
      )}
    </li>
  )
}

export default function ArtworkSlots({ taskKey, line, slots, driveConnected, folderUrl, onUploaded, me, taskStatus, autoRender }: {
  taskKey: string; line: WorkspaceLine; slots: string[]; driveConnected: boolean; folderUrl?: string | null
  onUploaded: () => void; me: Me; taskStatus: TaskStatus; autoRender?: ReactNode
}) {
  const up = useArtworkUpload(taskKey, onUploaded)
  const remover = useArtworkRemove(onUploaded)
  const lightbox = useLightbox()
  const [said, setSaid] = useState('')
  const slotInputs = useRef<Record<string, HTMLInputElement | null>>({})
  const parts = printPartNames(line, slots)
  const mockups = mockupFiles(line)
  const printCount = parts.filter(p => versionsFor(line, p).length > 0).length

  function say(msg: string) {
    setSaid(msg)
    window.setTimeout(() => setSaid(''), 2500)
  }

  const actions: RowActions = {
    taskKey, driveConnected, me, taskStatus,
    busyPart: (kind, part) => up.active.some(i => i.kind === kind && i.part === part),
    onReplace: (kind, part, file) => up.upload(part, file, kind),
    onRemove: remover.ask,
    onChanged: onUploaded,
    onSay: say,
    onError: up.setError,
  }

  return (
    <Card icon="folder_open" title="File của task" right={`${printCount} file in · ${mockups.length} mockup`}>
      {remover.dialog}
      <div className="flex items-center gap-sm flex-wrap rounded-lg bg-surface-container-low px-sm py-xs">
        <DriveFolderLink folderUrl={folderUrl} driveConnected={driveConnected} onCopied={say} />
        <span className="ml-auto text-label-sm text-on-surface-variant">Mọi file upload ở đây đều vào thư mục này</span>
      </div>
      {autoRender}
      <ErrorBanner msg={up.error} onClose={() => up.setError('')} />
      <span role="status" aria-live="polite" className={said ? 'text-label-sm text-on-surface-variant' : 'sr-only'}>{said}</span>
      {Object.entries(up.warnings).map(([area, msg]) => <Note key={area} tone="warn" icon="cloud_off">{area}: {msg}</Note>)}

      <section aria-label="File in" className="flex flex-col gap-xs">
        <h3 className="flex items-center gap-xs text-label-sm font-bold uppercase tracking-wider text-on-surface-variant">
          <Icon name="print" className="text-[16px]" />File in
          <span className="normal-case tracking-normal font-medium">
            {slots.length > 0 ? `${slots.length} vùng in của template + file khác` : 'mỗi tên file là một file riêng · trùng tên = phiên bản mới'}
          </span>
        </h3>
        <ul className="flex flex-col gap-xs">
          {parts.map(part => {
            const versions = versionsFor(line, part)
            if (versions.length > 0) return <PartRow key={part} versions={versions} renamable={!slots.includes(part)} actions={actions} />
            const pct = up.progress[part]
            return (
              <li key={part} className="rounded-lg border border-dashed border-error/50 p-xs flex items-center gap-sm">
                <span className="w-10 h-10 rounded-md bg-surface-container-low grid place-items-center text-error"><Icon name="add_photo_alternate" className="text-[18px]" /></span>
                <span className="min-w-0 flex-1 flex flex-col">
                  <span className="text-body-sm font-semibold text-on-surface">{part}</span>
                  <span className="text-label-sm text-error">chưa có file — vùng in bắt buộc của template</span>
                </span>
                <input ref={el => { slotInputs.current[part] = el }} type="file" accept={ARTWORK_ACCEPT} hidden aria-label={`Chọn file cho ${part}`}
                  onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) up.upload(part, f) }} />
                <button type="button" className={btn} disabled={pct !== undefined} onClick={() => slotInputs.current[part]?.click()}>
                  <Icon name="upload" className="text-[16px]" />{pct !== undefined ? up.busyLabel(pct) : 'Upload'}
                </button>
              </li>
            )
          })}
        </ul>
        <DropZone label={slots.length > 0 ? 'Thêm file in khác (chọn hoặc kéo thả nhiều file)' : 'Thêm file in (chọn hoặc kéo thả nhiều file)'}
          accept={ARTWORK_ACCEPT} multiple onFiles={files => up.uploadFiles(files, { kind: 'PRINT' })}>
          <span className="inline-flex items-center gap-xs font-semibold"><Icon name="add" className="text-[16px]" />{slots.length > 0 ? 'Thêm file khác' : 'Thêm file in'}</span>
          <span className="block">Kéo thả hoặc bấm để chọn nhiều file PNG/JPG/PDF/PSD/TIF/ZIP — vd front.png, back.png, sleeve.png</span>
        </DropZone>
      </section>

      <section aria-label="Mockup" className="flex flex-col gap-xs">
        <h3 className="flex items-center gap-xs text-label-sm font-bold uppercase tracking-wider text-on-surface-variant">
          <Icon name="checkroom" className="text-[16px]" />Mockup xưởng
          <span className="normal-case tracking-normal font-medium">không bắt buộc · vào cùng thư mục với tên MOCKUP_…</span>
        </h3>
        {mockups.length > 0 && (
          <ul className="flex flex-col gap-xs">
            {mockups.map(m => <PartRow key={m.printArea} versions={versionsFor(line, m.printArea, 'MOCKUP')} renamable actions={actions} />)}
          </ul>
        )}
        <DropZone label="Thêm mockup (chọn hoặc kéo thả nhiều ảnh)" accept={MOCKUP_ACCEPT} multiple onFiles={files => up.uploadFiles(files, { kind: 'MOCKUP' })}>
          <span className="inline-flex items-center gap-xs font-semibold"><Icon name="add" className="text-[16px]" />Thêm mockup</span>
          <span className="block">Ảnh PNG/JPG — dùng khi chưa có mockup tự động hoặc không có link preview</span>
        </DropZone>
      </section>

      <UploadList items={up.items} onDismiss={up.dismiss} />

      {line.sourcePrintFiles.map(f => (
        <div key={f.url} className="grid grid-cols-[32px_minmax(0,1fr)_auto] gap-sm items-center p-xs rounded-lg border border-outline-variant/20">
          <span className="w-8 h-8 rounded-md bg-surface-container-low grid place-items-center text-on-surface-variant"><Icon name="link" className="text-[18px]" /></span>
          <span className="min-w-0 flex items-center gap-xs">
            <Pill tone="idle">nguồn</Pill>
            <span className="text-label-sm truncate">{f.printArea} · {f.url.split('/').pop()}</span>
          </span>
          {lightbox
            ? <button type="button" onClick={() => lightbox.open(f.url, { url: f.url, label: `File nguồn · ${f.printArea}` })} aria-label={`Xem file nguồn ${f.printArea}`} title="Xem ảnh" className="text-on-surface-variant hover:text-secondary">
                <Icon name="zoom_in" className="text-[18px]" />
              </button>
            : <a href={f.url} target="_blank" rel="noreferrer" aria-label={`Mở file nguồn ${f.printArea}`} className="text-on-surface-variant hover:text-secondary">
                <Icon name="open_in_new" className="text-[18px]" />
              </a>}
        </div>
      ))}
    </Card>
  )
}
