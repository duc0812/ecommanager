'use client'
import { useState } from 'react'
import type { LayerFields } from '@/lib/artwork-fields'
import type { LibraryEntryView } from '@/lib/artwork-library-types'
import { Icon, btn, btnPrimary, input } from '../../components/ui'

type Row = { name: string; text: string; font: string }

export function pickerRows(entry: Pick<LibraryEntryView, 'fixedTexts' | 'fields' | 'layerFields'>): Row[] {
  const rows = new Map<string, Row>()
  for (const t of entry.fixedTexts) if (!t.name.trim().startsWith('@')) rows.set(t.name, { name: t.name, text: t.text, font: t.font })
  for (const f of entry.fields) {
    if (entry.layerFields[f.layer] !== undefined && !rows.has(f.layer)) rows.set(f.layer, { name: f.layer, text: f.sample, font: f.font })
  }
  for (const name of Object.keys(entry.layerFields)) if (!rows.has(name)) rows.set(name, { name, text: '', font: '' })
  return Array.from(rows.values())
}

export default function LayerFieldPicker({ entry, observedFields, disabled, onSave }: {
  entry: LibraryEntryView; observedFields: string[]; disabled: boolean; onSave: (layerFields: LayerFields) => Promise<boolean | undefined>
}) {
  const [draft, setDraft] = useState<LayerFields | null>(null)
  const rows = pickerRows(entry)
  if (rows.length === 0) return null
  const current = draft ?? entry.layerFields
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(entry.layerFields)
  const choices = Array.from(new Set([...observedFields, ...Object.values(current)]))

  function set(layer: string, field: string) {
    const next = { ...current }
    if (field) next[layer] = field
    else delete next[layer]
    setDraft(next)
  }

  return (
    <div className="border-t border-outline-variant/20 overflow-x-auto">
      <div className="flex items-center gap-sm px-md py-xs flex-wrap">
        <b className="text-label-sm text-on-surface">Layer chữ ({rows.length})</b>
        <span className="text-label-sm text-on-surface-variant">PSD không đặt tên <code className="font-mono">@</code>: chọn layer nào là chữ khách. Lưu sẽ đọc lại PSD.</span>
        {dirty && (
          <span className="ml-auto flex gap-xs">
            <button type="button" className={btn} onClick={() => setDraft(null)}>Huỷ</button>
            <button type="button" className={btnPrimary} disabled={disabled}
              onClick={() => void onSave(current).then(ok => { if (ok) setDraft(null) })}>
              <Icon name="save" className="text-[16px]" />Lưu &amp; đọc lại
            </button>
          </span>
        )}
      </div>
      <table className="w-full border-collapse text-body-sm">
        <thead>
          <tr className="text-label-sm text-on-surface-variant text-left border-y border-outline-variant/20">
            <th className="px-md py-xs font-medium">Layer</th>
            <th className="px-sm py-xs font-medium">Chữ mẫu</th>
            <th className="px-sm py-xs font-medium">Font</th>
            <th className="px-sm py-xs font-medium">Dùng làm</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.name} className="border-b border-outline-variant/20 last:border-b-0">
              <td className="px-md py-xs font-mono text-label-sm text-on-surface">{r.name}</td>
              <td className="px-sm py-xs text-on-surface-variant max-w-[240px] truncate" title={r.text}>{r.text || '—'}</td>
              <td className="px-sm py-xs font-mono text-label-sm text-on-surface-variant">{r.font || '—'}</td>
              <td className="px-sm py-xs">
                <select className={input} value={current[r.name] ?? ''} disabled={disabled} onChange={e => set(r.name, e.target.value)} aria-label={`Vai trò layer ${r.name}`}>
                  <option value="">Chữ cố định</option>
                  {choices.map(f => <option key={f} value={f}>Trường khách: {f}</option>)}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
