'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import type { DropshipRow } from '@/lib/dropship'
import { productPageUrl, requestJson } from './model'
import { ErrorBanner, Icon, Pill, btnPrimary, card, fmtDate, input } from './ui'

type Lists = { unmapped: DropshipRow[]; mapped: DropshipRow[] }
type SupplierProduct = { id: string; sku: string; productName: string | null; supplierId: string; variant1Value: string | null; variant2Value: string | null }
type Catalog = { suppliers: { id: string; name: string }[]; products: SupplierProduct[] }

const PRODUCT_GID = 'gid://shopify/Product/'

function productKey(r: DropshipRow): string | null {
  if (!r.shopifyProductId) return null
  const id = r.shopifyProductId.startsWith(PRODUCT_GID) ? r.shopifyProductId.slice(PRODUCT_GID.length) : r.shopifyProductId
  return `${r.storeId}~${id}`
}

function Thumb({ url }: { url: string | null }) {
  return url
    ? <img src={url} alt="" className="w-12 h-12 rounded-lg object-cover border border-outline-variant/30 shrink-0" />
    : <div className="w-12 h-12 rounded-lg bg-surface-container grid place-items-center shrink-0"><Icon name="image_not_supported" className="text-on-surface-variant" /></div>
}

function ProductTitle({ r }: { r: DropshipRow }) {
  const key = productKey(r)
  return (
    <div className="min-w-0">
      {key
        ? <Link href={productPageUrl(key)} className="text-body-sm font-semibold text-on-surface hover:underline">{r.productTitle}</Link>
        : <span className="text-body-sm font-semibold text-on-surface">{r.productTitle}</span>}
      <div className="text-label-sm text-on-surface-variant">{r.variantTitle ?? 'Default'} · SKU {r.sku ?? '—'} · {r.store}</div>
    </div>
  )
}

function MapForm({ group, catalog, onMapped, onError }: { group: DropshipRow[]; catalog: Catalog | null; onMapped: () => void; onError: (m: string) => void }) {
  const first = group[0]
  const [supplierId, setSupplierId] = useState('')
  const [productId, setProductId] = useState('')
  const [q, setQ] = useState('')
  const [saving, setSaving] = useState(false)
  const options = useMemo(() => {
    if (!catalog || !supplierId) return []
    const needle = q.trim().toLowerCase()
    return catalog.products
      .filter(p => p.supplierId === supplierId)
      .filter(p => !needle || `${p.sku} ${p.productName ?? ''} ${p.variant1Value ?? ''} ${p.variant2Value ?? ''}`.toLowerCase().includes(needle))
      .slice(0, 200)
  }, [catalog, supplierId, q])

  if (!first.shopifyVariantId) {
    return <Link href="/fulfillment/mapping" className="text-label-sm text-secondary hover:underline">Dòng không có variant — map ở trang Mapping</Link>
  }
  const save = async () => {
    if (!productId) return
    setSaving(true)
    const r = await requestJson('/api/fulfillment/mapping/manual', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shopifyVariantId: first.shopifyVariantId, shopifyProductTitle: first.productTitle, variantTitle: first.variantTitle, supplierProductId: productId, notes: 'Dropship' }),
    })
    setSaving(false)
    if (!r.ok) { onError(r.error); return }
    onMapped()
  }
  return (
    <div className="flex items-center gap-xs flex-wrap">
      <select aria-label="Xưởng" className={input} value={supplierId} onChange={e => { setSupplierId(e.target.value); setProductId('') }}>
        <option value="">Chọn xưởng…</option>
        {(catalog?.suppliers ?? []).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
      {supplierId && <input aria-label="Tìm SKU xưởng" className={`${input} w-[140px]`} placeholder="Tìm SKU…" value={q} onChange={e => setQ(e.target.value)} />}
      {supplierId && (
        <select aria-label="SKU xưởng" className={`${input} max-w-[280px]`} value={productId} onChange={e => setProductId(e.target.value)}>
          <option value="">{options.length ? 'Chọn SKU xưởng…' : 'Xưởng này chưa có SKU khớp'}</option>
          {options.map(p => <option key={p.id} value={p.id}>{p.sku}{p.productName ? ` — ${p.productName}` : ''}{p.variant1Value ? ` · ${p.variant1Value}` : ''}{p.variant2Value ? ` · ${p.variant2Value}` : ''}</option>)}
        </select>
      )}
      <button type="button" className={btnPrimary} disabled={!productId || saving} onClick={save}>
        <Icon name="link" className="text-[16px]" />{saving ? 'Đang map…' : `Map ${group.length > 1 ? `${group.length} dòng` : ''}`}
      </button>
    </div>
  )
}

export default function DropshipGrid({ q, version, onSend, onCount }: { q: string; version: number; onSend: (orderNumber: string) => void; onCount: (n: number) => void }) {
  const [lists, setLists] = useState<Lists | null>(null)
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    const r = await requestJson<Lists>(`/api/design-studio/dropship${q ? `?q=${encodeURIComponent(q)}` : ''}`)
    setLoading(false)
    if (!r.ok) { setError(r.error); return }
    setLists(r.data)
    if (!q) onCount(r.data.unmapped.length + r.data.mapped.length)
  }, [q, onCount])

  useEffect(() => { load() }, [load, version])
  useEffect(() => {
    requestJson<Catalog>('/api/fulfillment/mapping/supplier-products').then(r => {
      if (r.ok) setCatalog(r.data)
      else if (r.status !== 403) setError(r.error)
    })
  }, [])

  const groups = useMemo(() => {
    const byVariant = new Map<string, DropshipRow[]>()
    for (const r of lists?.unmapped ?? []) {
      const k = r.shopifyVariantId ?? r.lineId
      byVariant.set(k, [...(byVariant.get(k) ?? []), r])
    }
    return Array.from(byVariant.values())
  }, [lists])

  return (
    <div className="flex flex-col gap-md min-w-0">
      {error && <ErrorBanner msg={error} onClose={() => setError('')} />}
      <div className={`${card} px-lg py-md text-body-sm text-on-surface-variant flex items-start gap-sm`}>
        <Icon name="local_shipping" className="text-[20px] text-secondary" />
        <span>Hàng dropship mua sẵn từ xưởng: không cần file in, không tạo task design. Map xưởng ở đây, rồi gửi ở tab <b>Duyệt sản xuất</b> (CSV hoặc API Bondre). Bật / tắt dropship ở trang sản phẩm.</span>
      </div>

      <section className={card}>
        <div className="flex items-center gap-sm px-lg py-md border-b border-outline-variant/20">
          <Icon name="link_off" className="text-[20px] text-amber-800" />
          <h2 className="text-body-md font-semibold text-on-surface">Chưa map xưởng</h2>
          <Pill tone={groups.length ? 'warn' : 'idle'}>{lists?.unmapped.length ?? 0} dòng</Pill>
        </div>
        {loading && !lists ? <div className="px-lg py-md text-body-sm text-on-surface-variant">Đang tải…</div>
          : groups.length === 0 ? <div className="px-lg py-md text-body-sm text-on-surface-variant">Không có dòng dropship nào chờ map.</div>
          : groups.map(g => (
            <div key={g[0].lineId} className="flex items-start gap-md px-lg py-md border-b border-outline-variant/10 last:border-0">
              <Thumb url={g[0].imageUrl} />
              <div className="flex-1 min-w-0 flex flex-col gap-xs">
                <ProductTitle r={g[0]} />
                <div className="text-label-sm text-on-surface-variant">
                  {g.map(r => `${r.orderNumber} (${fmtDate(r.placedAt)}, SL ${r.qty})`).join(' · ')}
                </div>
                <MapForm group={g} catalog={catalog} onMapped={load} onError={setError} />
              </div>
            </div>
          ))}
      </section>

      <section className={card}>
        <div className="flex items-center gap-sm px-lg py-md border-b border-outline-variant/20">
          <Icon name="inventory_2" className="text-[20px] text-secondary" />
          <h2 className="text-body-md font-semibold text-on-surface">Đã map — chờ gửi</h2>
          <Pill tone={lists?.mapped.length ? 'brand' : 'idle'}>{lists?.mapped.length ?? 0} dòng</Pill>
        </div>
        {(lists?.mapped ?? []).length === 0
          ? <div className="px-lg py-md text-body-sm text-on-surface-variant">{loading && !lists ? 'Đang tải…' : 'Không có dòng dropship nào chờ gửi.'}</div>
          : lists!.mapped.map(r => (
            <div key={r.lineId} className="flex items-center gap-md px-lg py-md border-b border-outline-variant/10 last:border-0">
              <Thumb url={r.imageUrl} />
              <div className="flex-1 min-w-0"><ProductTitle r={r} /></div>
              <div className="text-label-sm text-on-surface-variant whitespace-nowrap">{r.orderNumber} · {fmtDate(r.placedAt)} · SL {r.qty}</div>
              <div className="text-label-sm text-on-surface whitespace-nowrap">{r.supplier?.name} · {r.supplierSku ?? '—'}</div>
              <button type="button" className={btnPrimary} onClick={() => onSend(r.orderNumber)}>
                <Icon name="send" className="text-[16px]" />Gửi xưởng
              </button>
            </div>
          ))}
      </section>
    </div>
  )
}
