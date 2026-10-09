'use client'
import { useRef, useState } from 'react'

export type ArtworkRow = { id: string; printArea: string; version: number; fileName: string; size: number; mimeType: string; uploadedById: string | null; createdAt: string; url: string }
export type WorkspaceLine = {
  id: string; linePosition: number; sku: string | null; productTitle: string; variantTitle: string | null; qty: number
  isNonProduct: boolean; customized: boolean; variantOptions: Record<string, string>; attributesLoaded: boolean
  personalization: { key: string; value: string }[]; customerDesignLink: string | null; customizedUrl: string | null
  previewUrl: string | null; sourcePrintFiles: { printArea: string; url: string }[]
  supplier: { id: string; name: string; code: string } | null; supplierSku: string | null; templateUrl: string | null
  masterArtworkUrl: string | null; libraryDesignLink: string | null; designStatus: string
  designDriveLink: string | null; designNote: string | null; printAreas: string[]; artworks: ArtworkRow[]
}

const card = 'bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20'
const head = 'flex items-center gap-sm px-lg py-md border-b border-outline-variant/20 text-label-md text-on-surface-variant'

function fmtSize(n: number) { return n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB` }
function hasNonAscii(s: string) { return /[^\x00-\x7F]/.test(s) }

export default function LineBlock({ line, onChanged }: { line: WorkspaceLine; onChanged: () => void }) {
  const [note, setNote] = useState(line.designNote ?? '')
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({})
  const done = !!line.designDriveLink
  const slotsFilled = line.printAreas.every(a => line.artworks.some(x => x.printArea === a))

  async function patch(body: { note?: string | null; done?: boolean }) {
    setBusy('patch'); setMsg('')
    const res = await fetch(`/api/design-studio/lines/${line.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const d = await res.json().catch(() => ({}))
    setBusy('')
    if (!res.ok) { setMsg(d.error ?? 'Lỗi'); return }
    onChanged()
  }

  async function upload(printArea: string, file: File) {
    if (busy === printArea) return
    setBusy(printArea); setMsg('')
    const fd = new FormData(); fd.set('printArea', printArea); fd.set('file', file)
    const res = await fetch(`/api/design-studio/lines/${line.id}/artwork`, { method: 'POST', body: fd })
    const d = await res.json().catch(() => ({}))
    setBusy('')
    if (!res.ok) { setMsg(d.error ?? 'Upload lỗi'); return }
    onChanged()
  }

  async function copy(v: string) { try { await navigator.clipboard.writeText(v); setMsg(`Đã chép "${v}"`) } catch { setMsg('Không chép được') } }

  if (line.isNonProduct) {
    return <div className={`${card} px-lg py-md text-body-sm text-on-surface-variant`}>Dòng {line.linePosition}: {line.productTitle} — không cần design</div>
  }

  return (
    <div className={`${card} ${done ? 'border-tertiary/40' : ''}`}>
      <div className={head}>
        <span className="material-symbols-outlined">{done ? 'task_alt' : 'brush'}</span>
        <span>Dòng {line.linePosition}</span>
        <span className="text-on-surface font-semibold truncate">{line.productTitle}</span>
        {line.variantTitle && <span className="text-on-surface-variant">· {line.variantTitle}</span>}
        <span className="ml-auto">SKU <b className="text-on-surface">{line.sku ?? '—'}</b> · x{line.qty}</span>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-lg p-lg">
        <section className="flex flex-col gap-md">
          <h3 className="text-label-md text-on-surface-variant">Thông tin custom</h3>
          {!line.attributesLoaded && (
            <div className="px-md py-sm rounded-lg bg-surface-container text-body-sm text-on-surface-variant">Chưa có dữ liệu custom cho dòng này — bấm “Nạp lại từ Shopify” ở đầu trang.</div>
          )}
          {line.personalization.length === 0 && line.attributesLoaded && (
            <div className="text-body-sm text-on-surface-variant">Khách không nhập gì.{Object.keys(line.variantOptions).length > 0 && ' Biến thể: ' + Object.entries(line.variantOptions).map(([k, v]) => `${k}: ${v}`).join(', ')}</div>
          )}
          {line.personalization.length > 0 && (
            <table className="w-full text-body-sm">
              <tbody>
                {line.personalization.map(a => (
                  <tr key={a.key} className="border-b border-dashed border-outline-variant/30">
                    <td className="py-xs pr-md text-on-surface-variant w-2/5 align-top">{a.key}</td>
                    <td className="py-xs">
                      <code className="px-sm py-xs rounded-md bg-surface-container border border-outline-variant/30">{a.value}</code>
                      <button onClick={() => copy(a.value)} className="ml-xs text-on-surface-variant hover:text-secondary align-middle" title="Chép"><span className="material-symbols-outlined text-[16px]">content_copy</span></button>
                      {hasNonAscii(a.value) && <span className="ml-xs px-sm rounded-md bg-error-container text-on-error-container text-label-sm">ký tự đặc biệt</span>}
                      {a.value.length > 14 && <span className="ml-xs px-sm rounded-md bg-amber-100 text-amber-900 text-label-sm">{a.value.length} ký tự</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="flex flex-wrap gap-sm text-body-sm">
            {line.customerDesignLink && <a className="text-secondary hover:underline" href={line.customerDesignLink} target="_blank" rel="noreferrer">Mở lại thiết kế của khách ↗</a>}
            {line.customizedUrl && <a className="text-secondary hover:underline" href={line.customizedUrl} target="_blank" rel="noreferrer">Customized URL ↗</a>}
          </div>

          <h3 className="text-label-md text-on-surface-variant mt-sm">Supplier & template</h3>
          <dl className="grid grid-cols-[140px_1fr] gap-y-xs text-body-sm">
            <dt className="text-on-surface-variant">Supplier</dt><dd>{line.supplier ? `${line.supplier.name} (${line.supplier.code})` : <span className="text-error">chưa map</span>}</dd>
            <dt className="text-on-surface-variant">SKU xưởng</dt><dd>{line.supplierSku ?? '—'}</dd>
            <dt className="text-on-surface-variant">Template</dt><dd>{line.templateUrl ? <a className="text-secondary hover:underline" href={line.templateUrl} target="_blank" rel="noreferrer">Mở template ↗</a> : <span className="text-amber-900">chưa có template cho SKU này</span>}</dd>
            <dt className="text-on-surface-variant">Master artwork</dt><dd>{line.masterArtworkUrl ? <a className="text-secondary hover:underline" href={line.masterArtworkUrl} target="_blank" rel="noreferrer">Mở master ↗</a> : '—'}</dd>
            <dt className="text-on-surface-variant">Design Library</dt><dd>{line.libraryDesignLink ? <a className="text-secondary hover:underline" href={line.libraryDesignLink} target="_blank" rel="noreferrer">Có design sẵn ↗</a> : line.designStatus}</dd>
          </dl>
        </section>

        <section className="flex flex-col gap-md">
          <h3 className="text-label-md text-on-surface-variant">Mockup / preview</h3>
          {line.previewUrl
            ? <a href={line.previewUrl} target="_blank" rel="noreferrer"><img src={line.previewUrl} alt="Preview" className="max-h-64 rounded-lg border border-outline-variant/30 object-contain bg-surface-container" /></a>
            : <div className="text-body-sm text-on-surface-variant">Không có preview.</div>}
          {line.sourcePrintFiles.length > 0 && (
            <div className="flex flex-wrap gap-sm">
              {line.sourcePrintFiles.map(f => (
                <a key={f.url} href={f.url} target="_blank" rel="noreferrer" className="px-md py-xs rounded-lg border border-outline-variant/40 text-body-sm hover:bg-surface-container">File in từ app · {f.printArea} ↗</a>
              ))}
            </div>
          )}

          <h3 className="text-label-md text-on-surface-variant mt-sm">Artwork theo template</h3>
          {line.printAreas.map(area => {
            const versions = line.artworks.filter(a => a.printArea === area)
            return (
              <div key={area} className="rounded-lg border border-outline-variant/30 p-md flex flex-col gap-sm">
                <div className="flex items-center gap-sm">
                  <span className="font-semibold text-body-sm">{area}</span>
                  <span className="text-label-sm text-on-surface-variant">{versions.length ? `${versions.length} phiên bản` : 'chưa có file'}</span>
                  <input ref={el => { fileInputs.current[area] = el }} type="file" accept=".png,.jpg,.jpeg,.pdf,.psd,.zip" hidden aria-label={`Upload ${area}`}
                    onChange={e => { const f = e.target.files?.[0]; if (f) upload(area, f); e.target.value = '' }} />
                  <button disabled={busy === area} onClick={() => fileInputs.current[area]?.click()}
                    className="ml-auto bg-secondary text-on-secondary px-md py-xs rounded-lg text-label-sm disabled:opacity-50">
                    {busy === area ? 'Đang tải…' : 'Upload'}
                  </button>
                </div>
                <div onDragOver={e => { e.preventDefault() }} onDrop={e => { e.preventDefault(); if (busy === area) return; const f = e.dataTransfer.files?.[0]; if (f) upload(area, f) }}
                  className="rounded-md border border-dashed border-outline-variant/50 px-md py-sm text-label-sm text-on-surface-variant text-center">
                  Kéo thả file vào đây (png, jpg, pdf, psd, zip)
                </div>
                {versions.map(v => (
                  <div key={v.id} className="flex items-center gap-sm text-body-sm">
                    <span className="material-symbols-outlined text-on-surface-variant">{v.mimeType.startsWith('image/') ? 'image' : 'description'}</span>
                    <a href={v.url} target="_blank" rel="noreferrer" className="text-secondary hover:underline truncate">v{v.version} · {v.fileName}</a>
                    <span className="ml-auto text-on-surface-variant whitespace-nowrap">{fmtSize(v.size)} · {new Date(v.createdAt).toLocaleString('en-US')}</span>
                  </div>
                ))}
              </div>
            )
          })}

          <h3 className="text-label-md text-on-surface-variant mt-sm">Ghi chú</h3>
          <textarea value={note} onChange={e => setNote(e.target.value)} onBlur={() => note !== (line.designNote ?? '') && patch({ note })}
            rows={2} placeholder="Ghi chú cho người duyệt hoặc CS…" aria-label="Ghi chú" className="w-full px-md py-sm rounded-lg border border-outline-variant/40 bg-surface-container-lowest text-body-sm" />

          <div className="flex items-center gap-sm mt-xs">
            {msg && <span className="text-body-sm text-on-surface-variant">{msg}</span>}
            <div className="ml-auto flex gap-sm">
              {done
                ? <button disabled={busy === 'patch'} onClick={() => patch({ done: false })} className="px-md py-sm rounded-lg border border-outline-variant/40 text-label-md">Mở lại</button>
                : <button disabled={busy === 'patch' || !slotsFilled} title={slotsFilled ? '' : 'Upload đủ mọi vùng in trước'} onClick={() => patch({ done: true })}
                    className="bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md disabled:opacity-40">Đánh dấu xong</button>}
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
