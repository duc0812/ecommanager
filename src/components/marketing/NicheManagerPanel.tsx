'use client'
import { useCallback, useEffect, useState } from 'react'

type Niche = { id: string; name: string; keywords: string; active: boolean; sortOrder: number }

function parseKw(json: string): string[] {
  try { const a = JSON.parse(json); return Array.isArray(a) ? a.map(String) : [] } catch { return [] }
}

async function send(method: string, body: unknown) {
  const res = await fetch('/api/marketing/niches', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? `${method} failed with ${res.status}`)
  return data
}

export default function NicheManagerPanel({ open, onClose, onChanged }: { open: boolean; onClose: () => void; onChanged: () => void }) {
  const [rows, setRows] = useState<Niche[]>([])
  const [name, setName] = useState('')
  const [keywords, setKeywords] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    const res = await fetch('/api/marketing/niches')
    if (res.ok) setRows(await res.json())
  }, [])

  useEffect(() => { if (open) load() }, [open, load])

  const run = async (fn: () => Promise<unknown>) => {
    setError('')
    try { await fn(); await load(); onChanged() } catch (e: any) { setError(e.message) }
  }

  const add = () => run(async () => {
    if (!name.trim()) throw new Error('Nhập tên niche')
    await send('POST', { name, keywords })
    setName(''); setKeywords('')
  })

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-primary/40" onClick={onClose} />
      <aside className="w-full max-w-2xl h-full overflow-y-auto bg-surface-container-lowest shadow-card border-l border-outline-variant/20 p-lg">
        <div className="flex items-center justify-between mb-lg">
          <h2 className="text-headline-sm text-primary">Quản lý niche</h2>
          <button onClick={onClose} className="material-symbols-outlined text-on-surface-variant">close</button>
        </div>

        <section className="mb-lg rounded-xl border border-outline-variant/20 bg-surface-container-low p-md">
          <div className="grid grid-cols-1 gap-sm md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]">
            <input value={name} onChange={e => setName(e.target.value)} placeholder="Tên niche (Jeep, PoMo…)"
              className="min-w-0 w-full rounded-lg border border-outline-variant/30 bg-surface-container-lowest px-md py-sm text-body-md outline-none focus:border-secondary" />
            <input value={keywords} onChange={e => setKeywords(e.target.value)} placeholder="keywords: jeep, jeep girl"
              className="min-w-0 w-full rounded-lg border border-outline-variant/30 bg-surface-container-lowest px-md py-sm text-body-md outline-none focus:border-secondary" />
            <button onClick={add} className="rounded-lg bg-secondary px-lg py-sm text-label-md text-on-secondary">Thêm</button>
          </div>
          <p className="mt-xs text-body-sm text-on-surface-variant">
            Keyword match tên campaign và tên sản phẩm, không phân biệt hoa/thường. Niche đứng trước thắng khi nhiều niche cùng match.
          </p>
        </section>

        {error && <p className="mb-md text-body-sm text-error">{error}</p>}

        <ul className="space-y-sm">
          {rows.map(r => (
            <NicheRowEditor key={r.id} row={r}
              onSave={(patch) => run(() => send('PATCH', { id: r.id, ...patch }))}
              onRemove={() => {
                if (!confirm(`Xoá niche "${r.name}"? Các campaign đã gán tay vào niche này sẽ mất gán.`)) return
                run(() => send('DELETE', { id: r.id }))
              }} />
          ))}
          {rows.length === 0 && <p className="text-body-md text-on-surface-variant">Chưa có niche nào.</p>}
        </ul>
      </aside>
    </div>
  )
}

function NicheRowEditor({ row, onSave, onRemove }: {
  row: Niche
  onSave: (patch: Partial<{ name: string; keywords: string; active: boolean; sortOrder: number }>) => void
  onRemove: () => void
}) {
  const [name, setName] = useState(row.name)
  const [kw, setKw] = useState(parseKw(row.keywords).join(', '))
  const [sortOrder, setSortOrder] = useState(String(row.sortOrder))
  const dirty = name !== row.name || kw !== parseKw(row.keywords).join(', ') || sortOrder !== String(row.sortOrder)

  return (
    <li className={`rounded-xl border border-outline-variant/20 p-md ${row.active ? 'bg-surface-container-lowest' : 'bg-surface-container opacity-70'}`}>
      <div className="flex flex-wrap items-center gap-sm">
        <input value={sortOrder} onChange={e => setSortOrder(e.target.value)} title="Thứ tự ưu tiên"
          className="w-14 rounded-lg border border-outline-variant/30 bg-surface-container px-sm py-xs text-body-sm text-center" />
        <input value={name} onChange={e => setName(e.target.value)}
          className="w-36 rounded-lg border border-outline-variant/30 bg-surface-container px-md py-xs text-label-md font-bold text-primary" />
        <input value={kw} onChange={e => setKw(e.target.value)} placeholder="keywords"
          className="min-w-[160px] flex-1 rounded-lg border border-outline-variant/30 bg-surface-container px-md py-xs text-body-sm" />
        <button
          disabled={!dirty}
          onClick={() => onSave({ name, keywords: kw, sortOrder: Number(sortOrder) || 0 })}
          className="rounded-lg bg-secondary px-md py-xs text-label-sm text-on-secondary disabled:opacity-40">Lưu</button>
        <button onClick={() => onSave({ active: !row.active })} className="rounded-lg bg-surface-container px-md py-xs text-label-sm">
          {row.active ? 'Tắt' : 'Bật'}
        </button>
        <button onClick={onRemove} className="text-error text-label-sm hover:underline">Xoá</button>
      </div>
    </li>
  )
}
