'use client'
import { useCallback, useEffect, useState, type FormEvent } from 'react'

type CatalogProduct = {
  sku: string
  name: string
  files: { name: string; note: string | null; sizeWidth: number | null; sizeHeight: number | null }[]
  shipClasses: string[]
  variants: { sku: string }[]
}

export type CatalogTarget = { id: string; sku: string; baseSku: string | null; apiSku: string | null; apiShipClass: string | null }

const pick = (on: boolean) =>
  `rounded-full border px-sm py-[2px] text-label-sm font-mono ${on ? 'bg-secondary text-on-secondary border-transparent' : 'border-outline-variant/40 hover:border-secondary hover:text-secondary'}`

export default function PgprintsCatalogLookup({ target, onPick, onClose }: {
  target: CatalogTarget
  onPick: (patch: { apiSku?: string; apiShipClass?: string }) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState(target.baseSku || target.sku)
  const [products, setProducts] = useState<CatalogProduct[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const search = useCallback(async (q: string) => {
    if (!q.trim()) return
    setBusy(true); setError('')
    try {
      const r = await fetch(`/api/fulfillment/pgprints/catalog?q=${encodeURIComponent(q.trim())}`)
      const data = await r.json().catch(() => null)
      if (!r.ok) { setError(data?.error ?? 'Không tra được catalogue'); setProducts(null) }
      else setProducts(data.products ?? [])
    } catch {
      setError('Không kết nối được máy chủ')
    }
    setBusy(false)
  }, [])

  useEffect(() => { void search(target.baseSku || target.sku) }, [search, target.baseSku, target.sku])

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  function submit(e: FormEvent) {
    e.preventDefault()
    void search(query)
  }

  return (
    <div role="dialog" aria-modal="true" aria-label="Tra catalogue PGprints" className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-lg">
      <div className="max-h-[88vh] w-full max-w-3xl overflow-auto rounded-xl bg-surface-container-lowest shadow-xl">
        <div className="sticky top-0 flex items-center gap-sm border-b border-outline-variant/20 bg-surface-container-lowest px-lg py-md">
          <span className="material-symbols-outlined text-secondary">travel_explore</span>
          <div className="flex-1 min-w-0">
            <div className="text-title-md font-semibold">Tra catalogue PGprints</div>
            <div className="text-label-sm text-on-surface-variant truncate">
              Điền cho SKU <span className="font-mono">{target.sku}</span>
              {' · '}SKU API: <span className="font-mono">{target.apiSku ?? 'chưa có'}</span>
              {' · '}Ship class: {target.apiShipClass ?? 'chưa có'}
            </div>
          </div>
          <button type="button" onClick={onClose} className="border border-outline-variant/40 rounded-lg px-md py-xs text-label-md">Đóng</button>
        </div>

        <div className="p-lg flex flex-col gap-md">
          <form onSubmit={submit} className="flex items-center gap-sm">
            <input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder="SKU gốc hoặc tên sản phẩm, vd UT2"
              className="flex-1 border border-outline-variant/40 rounded-lg px-md py-sm text-body-sm font-mono" />
            <button type="submit" disabled={busy || !query.trim()} className="bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md disabled:opacity-50">
              {busy ? 'Đang tra…' : 'Tra'}
            </button>
          </form>
          {error && <div role="alert" className="rounded-lg bg-error-container text-on-error-container px-sm py-xs text-label-sm">{error}</div>}
          {products && products.length === 0 && !error && (
            <div className="text-body-sm text-on-surface-variant">PGprints không có sản phẩm nào khớp &quot;{query}&quot;.</div>
          )}

          {(products ?? []).map(p => (
            <div key={p.sku} className="rounded-xl border border-outline-variant/20">
              <div className="flex items-center gap-sm px-md py-sm border-b border-outline-variant/20">
                <span className="font-mono text-body-sm font-semibold">{p.sku}</span>
                <span className="flex-1 text-body-sm">{p.name}</span>
              </div>
              <div className="px-md py-sm flex flex-col gap-sm">
                <div>
                  <div className="text-label-sm text-on-surface-variant mb-xs">Biến thể — bấm để điền &quot;SKU API&quot;</div>
                  <div className="flex flex-wrap gap-xs">
                    {p.variants.length === 0 && <span className="text-label-sm text-on-surface-variant">không có biến thể</span>}
                    {p.variants.map(v => (
                      <button key={v.sku} type="button" onClick={() => onPick({ apiSku: v.sku })} className={pick(target.apiSku === v.sku)}>{v.sku}</button>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="text-label-sm text-on-surface-variant mb-xs">Ship class — bấm để điền</div>
                  <div className="flex flex-wrap gap-xs">
                    {p.shipClasses.length === 0 && <span className="text-label-sm text-on-surface-variant">không có ship class</span>}
                    {p.shipClasses.map(s => (
                      <button key={s} type="button" onClick={() => onPick({ apiShipClass: s })} className={pick(target.apiShipClass === s)}>{s}</button>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="text-label-sm text-on-surface-variant mb-xs">Vị trí file in</div>
                  <ul className="flex flex-col gap-[2px] text-label-sm">
                    {p.files.length === 0 && <li className="text-on-surface-variant">không khai báo</li>}
                    {p.files.map(f => (
                      <li key={f.name} className="flex items-center gap-sm flex-wrap">
                        <b>{f.name}</b>
                        <span className="font-mono">{f.sizeWidth && f.sizeHeight ? `${f.sizeWidth}×${f.sizeHeight} px` : 'không rõ khổ'}</span>
                        {f.note && <span className="text-on-surface-variant">{f.note}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
