'use client'
import { useState } from 'react'

type SkuOption = { skuName: string; skuCode: string | null; productName: string | null }
type Row = { id: string; sku: string; productName: string | null; variant1Value: string | null; apiSku: string | null; apiShipClass: string | null; suggestion: string | null }

async function patch(id: string, body: { apiSku?: string; apiShipClass?: string }): Promise<{ ok: boolean; error: string; data: any }> {
  try {
    const res = await fetch(`/api/suppliers/products/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const data = await res.json().catch(() => ({}))
    return { ok: res.ok, error: data.error ?? `Lỗi HTTP ${res.status}`, data }
  } catch {
    return { ok: false, error: 'Mất kết nối tới máy chủ', data: null }
  }
}

/** Which of a supplier's own SKUs each tool SKU is. `shipOptions` gives a list to pick from; without it the ship service is typed. */
export function SupplierSkuMapTable({ name, rows, skus, shipOptions, shipHint, onRows, onError }: {
  name: string; rows: Row[]; skus: SkuOption[]; shipOptions?: { value: string; label: string }[]; shipHint: string
  onRows: (rows: Row[]) => void; onError: (message: string) => void
}) {
  const [busy, setBusy] = useState('')
  const listId = `${name.toLowerCase()}-skus`

  async function save(row: Row, body: { apiSku?: string; apiShipClass?: string }) {
    if (body.apiSku && !skus.some(s => s.skuName === body.apiSku)) {
      onError(`${name} không có SKU "${body.apiSku}". Tên phải đúng từng ký tự, kể cả hoa thường.`)
      return
    }
    setBusy(row.id)
    const r = await patch(row.id, body)
    setBusy('')
    if (!r.ok) { onError(r.error); return }
    onRows(rows.map(x => x.id === row.id ? { ...x, apiSku: r.data.apiSku ?? null, apiShipClass: r.data.apiShipClass ?? null } : x))
  }

  return (
    <div className="border-t border-outline-variant/20 pt-md space-y-sm">
      <p className="text-body-sm text-on-surface">Đã ghép <b>{rows.filter(r => r.apiSku).length}/{rows.length}</b> SKU. SKU chưa ghép thì đơn không gửi được. {shipHint}</p>
      <datalist id={listId}>{skus.map(s => <option key={s.skuName} value={s.skuName}>{s.productName ?? ''}</option>)}</datalist>
      <div className="overflow-x-auto">
        <table className="w-full text-body-sm">
          <thead>
            <tr className="text-left text-label-sm text-on-surface-variant">
              <th className="px-sm py-xs font-semibold">SKU trong tool</th>
              <th className="px-sm py-xs font-semibold">Sản phẩm</th>
              <th className="px-sm py-xs font-semibold">SKU của {name}</th>
              <th className="px-sm py-xs font-semibold">Ship</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id} className="border-t border-outline-variant/20 align-top">
                <td className="px-sm py-xs font-mono text-xs">{r.sku}</td>
                <td className="px-sm py-xs">{r.productName ?? '—'}{r.variant1Value ? ` · ${r.variant1Value}` : ''}</td>
                <td className="px-sm py-xs">
                  <input key={`${r.id}:${r.apiSku ?? ''}`} list={listId} defaultValue={r.apiSku ?? ''} placeholder="chưa ghép" aria-label={`SKU ${name} của ${r.sku}`}
                    onBlur={e => { if (e.target.value.trim() !== (r.apiSku ?? '')) void save(r, { apiSku: e.target.value.trim() }) }}
                    className={`w-full min-w-[240px] border rounded px-xs py-[3px] font-mono text-xs ${r.apiSku ? '' : 'border-error/60'}`} />
                  {!r.apiSku && r.suggestion && (
                    <button type="button" className="mt-xs block text-label-sm text-secondary font-semibold text-left" disabled={!!busy} onClick={() => save(r, { apiSku: r.suggestion! })}>
                      Dùng gợi ý: {r.suggestion}
                    </button>
                  )}
                </td>
                <td className="px-sm py-xs">
                  {shipOptions ? (
                    <select value={r.apiShipClass ?? ''} aria-label={`Ship của ${r.sku}`} disabled={!!busy} onChange={e => save(r, { apiShipClass: e.target.value })} className="border rounded px-xs py-[3px] text-xs">
                      {shipOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  ) : (
                    <input key={`ship:${r.id}:${r.apiShipClass ?? ''}`} defaultValue={r.apiShipClass ?? ''} placeholder="mặc định" aria-label={`Ship của ${r.sku}`}
                      onBlur={e => { if (e.target.value.trim() !== (r.apiShipClass ?? '')) void save(r, { apiShipClass: e.target.value.trim() }) }}
                      className="w-[130px] border rounded px-xs py-[3px] text-xs" />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
