'use client'
import { useRef, useState, type FormEvent } from 'react'
import type { ArtworkRow, Me, TaskStatus } from './types'
import { artworkImage, artworkShareLink, canRemoveArtwork, copyText, isImage, patchJson, requestJson, taskUrl } from './model'
import { ARTWORK_ACCEPT, MOCKUP_ACCEPT } from './useArtworkUpload'
import { useLightbox } from './Lightbox'
import { ArtImg } from './art-src'
import { useToast } from './overlay'
import { Icon, fmtDateTime, fmtSize, input, menuItem, popover } from './ui'
import { PART_MAX } from '@/lib/task-files'

export type FileMenuProps = {
  versions: ArtworkRow[]
  taskKey: string; me: Me; taskStatus: TaskStatus; driveConnected: boolean
  /** Template areas keep their name; extra parts and mockups can be renamed. */
  renamable: boolean
  onReplace: (file: File) => void
  onRemove: (a: ArtworkRow) => void
  onChanged: () => void
  onClose: () => void
  className?: string
}

export default function FileMenu({ versions, taskKey, me, taskStatus, driveConnected, renamable, onReplace, onRemove, onChanged, onClose, className = '' }: FileMenuProps) {
  const v = versions[0]
  const older = versions.slice(1)
  const lightbox = useLightbox()
  const toast = useToast()
  const replaceInput = useRef<HTMLInputElement>(null)
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(v.printArea)
  const [saving, setSaving] = useState(false)
  const [pushing, setPushing] = useState(false)
  const isDrive = v.storage === 'DRIVE'
  const isMockup = v.kind === 'MOCKUP'
  const removable = canRemoveArtwork(v, me, taskStatus)
  const locked = taskStatus === 'DONE'

  async function rename(e: FormEvent) {
    e.preventDefault()
    const to = draft.trim()
    if (!to || to === v.printArea) { setRenaming(false); return }
    setSaving(true)
    const r = await patchJson(taskUrl(taskKey, '/parts'), { kind: v.kind, from: v.printArea, to })
    setSaving(false)
    if (!r.ok) { toast.say(r.error, 'bad'); return }
    onClose()
    onChanged()
  }

  async function push() {
    if (pushing) return
    setPushing(true)
    const r = await requestJson(`/api/design-studio/artwork/${encodeURIComponent(v.id)}/push`, { method: 'POST' })
    setPushing(false)
    if (!r.ok) { toast.say(`${v.printArea}: ${r.error}`, 'bad'); return }
    onChanged()
  }

  return (
    <div role="menu" aria-label={`Thao tác file ${v.printArea}`} className={`${popover} w-[320px] p-xs flex flex-col ${className}`}>
      <div className="flex gap-sm items-center px-sm pt-sm pb-sm">
        <span className="w-11 h-11 rounded-lg overflow-hidden bg-surface-container-low border border-outline-variant/20 grid place-items-center shrink-0">
          <ArtImg art={v} px={120} alt="" className="w-full h-full object-contain" loading="lazy"
            fallback={<Icon name={isImage(v) ? 'image' : 'description'} className="text-[20px] text-on-surface-variant" />} />
        </span>
        <span className="min-w-0 flex flex-col">
          <span className="text-body-sm font-semibold text-on-surface truncate">{isMockup ? 'Mockup · ' : ''}{v.printArea} · v{v.version}{v.source === 'AUTO' ? ' · tự động' : ''}</span>
          <span className="font-mono text-[11px] leading-4 text-on-surface-variant truncate" title={v.fileName}>{v.fileName}</span>
          <span className="text-label-sm text-on-surface-variant">
            {v.widthPx && v.heightPx ? `${v.widthPx}×${v.heightPx} · ` : ''}{fmtSize(v.size)} · {fmtDateTime(v.createdAt)} · {isDrive ? 'Drive' : 'Server'}
          </span>
        </span>
      </div>
      <div role="separator" className="h-px mx-sm mb-xs bg-outline-variant/60" />
      {isImage(v) && lightbox && (
        <button type="button" role="menuitem" className={menuItem} onClick={() => { onClose(); lightbox.open(v.url, artworkImage(v)) }}>
          <Icon name="zoom_in" className="text-[18px] text-on-surface-variant" />Xem cỡ thật
        </button>
      )}
      <input ref={replaceInput} type="file" accept={isMockup ? MOCKUP_ACCEPT : ARTWORK_ACCEPT} hidden aria-label={`Chọn file thay cho ${v.printArea}`}
        onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) { onReplace(f); onClose() } }} />
      <button type="button" role="menuitem" className={menuItem} onClick={() => replaceInput.current?.click()} title="Tải file mới — thành phiên bản tiếp theo, bản cũ giữ trong lịch sử">
        <Icon name="upload" className="text-[18px] text-on-surface-variant" /><span className="flex-1">Thay file</span><span className="text-label-sm text-on-surface-variant">thành v{v.version + 1}</span>
      </button>
      {renamable && (renaming ? (
        <form onSubmit={rename} className="flex items-center gap-xs px-sm py-xs">
          <input value={draft} onChange={e => setDraft(e.target.value)} maxLength={PART_MAX} autoFocus aria-label={`Tên mới cho ${v.printArea}`} className={`${input} flex-1`} />
          <button type="submit" disabled={saving} className="text-label-sm font-semibold text-secondary disabled:opacity-40">{saving ? 'Đang lưu…' : 'Lưu'}</button>
        </form>
      ) : (
        <button type="button" role="menuitem" className={menuItem} disabled={locked} onClick={() => { setDraft(v.printArea); setRenaming(true) }}
          title={locked ? 'Task đã duyệt design — bấm "Sửa & gửi lại" trước khi đổi tên' : 'Đổi tên file (áp dụng cho mọi phiên bản)'}>
          <Icon name="edit" className="text-[18px] text-on-surface-variant" />Đổi tên
        </button>
      ))}
      <a href={v.url} download={v.fileName} role="menuitem" className={menuItem} onClick={onClose}>
        <Icon name="download" className="text-[18px] text-on-surface-variant" />Tải xuống
      </a>
      <button type="button" role="menuitem" className={menuItem}
        onClick={async () => { onClose(); toast.say(await copyText(artworkShareLink(v)) ? `Đã chép link ${isDrive ? 'Drive' : 'file'} ${v.printArea}` : 'Không chép được link') }}>
        <Icon name="content_copy" className="text-[18px] text-on-surface-variant" />Copy link
      </button>
      {isDrive && v.driveWebViewLink && (
        <a href={v.driveWebViewLink} target="_blank" rel="noreferrer" role="menuitem" className={menuItem} onClick={onClose}>
          <Icon name="open_in_new" className="text-[18px] text-on-surface-variant" />Mở trên Drive
        </a>
      )}
      {!isDrive && driveConnected && (
        <button type="button" role="menuitem" className={menuItem} disabled={pushing} onClick={push}>
          <Icon name="cloud_upload" className="text-[18px] text-on-surface-variant" />{pushing ? 'Đang đẩy…' : 'Đẩy lên Drive'}
        </button>
      )}
      {older.length > 0 && (
        <details className="px-sm py-xs text-label-sm text-on-surface-variant">
          <summary className="cursor-pointer select-none">{older.length} phiên bản cũ</summary>
          <ul className="mt-xs flex flex-col gap-[2px]">
            {older.map(o => {
              const can = canRemoveArtwork(o, me, taskStatus)
              return (
                <li key={o.id} className="flex items-center gap-xs min-w-0">
                  <span className="font-semibold text-on-surface">v{o.version}</span>
                  <span className="truncate flex-1" title={o.fileName}>{o.fileName} · {fmtSize(o.size)}</span>
                  <a href={o.url} download={o.fileName} aria-label={`Tải ${o.printArea} v${o.version}`} title="Tải file" className="hover:text-secondary"><Icon name="download" className="text-[16px]" /></a>
                  <button type="button" onClick={() => { onClose(); onRemove(o) }} disabled={!can.ok} title={can.why ?? `Xoá ${o.printArea} v${o.version}`}
                    aria-label={`Xoá ${o.printArea} v${o.version}`} className="text-error disabled:opacity-40"><Icon name="delete" className="text-[16px]" /></button>
                </li>
              )
            })}
          </ul>
        </details>
      )}
      <div role="separator" className="h-px mx-sm my-xs bg-outline-variant/60" />
      <button type="button" role="menuitem" className={`${menuItem} text-error`} disabled={!removable.ok} title={removable.why}
        onClick={() => { onClose(); onRemove(v) }}>
        <Icon name="delete" className="text-[18px]" />Xoá file
      </button>
    </div>
  )
}
