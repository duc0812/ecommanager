'use client'
import { useEffect, useState, useCallback } from 'react'
import Sidebar from '@/components/Sidebar'

type Entry = {
  id: string; sku: string; supplierId: string; designLink: string | null
  ready: boolean; source: string; note: string | null; updatedAt: string
  supplier: { id: string; name: string; code: string }
}
type Supplier = { id: string; name: string; code: string }

export default function DesignLibraryPage() {
  const [entries, setEntries] = useState<Entry[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [filterSupplier, setFilterSupplier] = useState('')
  const [filterSku, setFilterSku] = useState('')
  const [filterReady, setFilterReady] = useState('')
  const [form, setForm] = useState({ sku: '', supplierId: '', designLink: '' })
  const [csv, setCsv] = useState('')
  const [msg, setMsg] = useState('')

  const load = useCallback(async () => {
    const qs = new URLSearchParams()
    if (filterSupplier) qs.set('supplierId', filterSupplier)
    if (filterSku) qs.set('sku', filterSku)
    if (filterReady) qs.set('ready', filterReady)
    const res = await fetch(`/api/fulfillment/design-library?${qs.toString()}`)
    const data = await res.json()
    setEntries(data.entries ?? [])
  }, [filterSupplier, filterSku, filterReady])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    fetch('/api/suppliers').then(r => r.json()).then(d => setSuppliers(d.suppliers ?? [])).catch(() => setSuppliers([]))
  }, [])

  async function addEntry() {
    if (!form.sku || !form.supplierId) { setMsg('Nhập SKU và chọn Supplier'); return }
    const res = await fetch('/api/fulfillment/design-library', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...form, ready: true }),
    })
    if (res.ok) { setForm({ sku: '', supplierId: '', designLink: '' }); setMsg('Đã lưu'); load() }
    else setMsg((await res.json()).error ?? 'Lỗi')
  }

  async function toggleReady(e: Entry) {
    await fetch('/api/fulfillment/design-library', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sku: e.sku, supplierId: e.supplierId, ready: !e.ready }),
    })
    load()
  }

  async function remove(id: string) {
    await fetch(`/api/fulfillment/design-library/${id}`, { method: 'DELETE' })
    load()
  }

  async function runImport() {
    const res = await fetch('/api/fulfillment/design-library/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ csv }),
    })
    const data = await res.json()
    setMsg(`Imported ${data.upserted ?? 0}. ${data.errors?.length ? 'Errors: ' + data.errors.join('; ') : ''}`)
    setCsv(''); load()
  }

  const groups = entries.reduce<{ sku: string; rows: Entry[] }[]>((acc, e) => {
    const last = acc[acc.length - 1]
    if (last && last.sku === e.sku) last.rows.push(e)
    else acc.push({ sku: e.sku, rows: [e] })
    return acc
  }, [])

  return (
    <div className="flex min-h-screen bg-surface">
      <Sidebar />
      <main className="ml-[280px] flex-1 p-xl">
        <h1 className="text-headline-md font-semibold mb-lg">Design Library</h1>

        <div className="bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20 p-lg mb-lg">
          <div className="flex items-center gap-sm mb-md">
            <span className="material-symbols-outlined">add_circle</span>
            <h2 className="text-title-md font-medium">Thêm design (xác nhận theo SKU)</h2>
          </div>
          <div className="flex flex-wrap gap-sm items-end">
            <input className="border border-outline-variant/40 rounded-lg px-md py-sm" placeholder="SKU"
              value={form.sku} onChange={e => setForm({ ...form, sku: e.target.value })} />
            <select className="border border-outline-variant/40 rounded-lg px-md py-sm"
              value={form.supplierId} onChange={e => setForm({ ...form, supplierId: e.target.value })}>
              <option value="">— Supplier —</option>
              {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <input className="border border-outline-variant/40 rounded-lg px-md py-sm flex-1 min-w-[280px]" placeholder="Design link (Drive/CDN)"
              value={form.designLink} onChange={e => setForm({ ...form, designLink: e.target.value })} />
            <button className="bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md" onClick={addEntry}>Lưu</button>
          </div>
          {msg && <p className="text-body-sm text-on-surface-variant mt-sm">{msg}</p>}
        </div>

        <div className="bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20 p-lg mb-lg">
          <div className="flex items-center gap-sm mb-md">
            <span className="material-symbols-outlined">upload_file</span>
            <h2 className="text-title-md font-medium">Import CSV (sku,supplierCode,designLink)</h2>
          </div>
          <textarea className="border border-outline-variant/40 rounded-lg px-md py-sm w-full h-24 font-mono text-body-sm"
            placeholder={'sku,supplierCode,designLink\nSKU1,printful,https://drive...'}
            value={csv} onChange={e => setCsv(e.target.value)} />
          <button className="bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md mt-sm" onClick={runImport}>Import</button>
        </div>

        <div className="flex flex-wrap gap-sm mb-md">
          <select className="border border-outline-variant/40 rounded-lg px-md py-sm" value={filterSupplier} onChange={e => setFilterSupplier(e.target.value)}>
            <option value="">All suppliers</option>
            {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <input className="border border-outline-variant/40 rounded-lg px-md py-sm" placeholder="Search SKU" value={filterSku} onChange={e => setFilterSku(e.target.value)} />
          <select className="border border-outline-variant/40 rounded-lg px-md py-sm" value={filterReady} onChange={e => setFilterReady(e.target.value)}>
            <option value="">Ready: all</option>
            <option value="true">Ready</option>
            <option value="false">Not ready</option>
          </select>
        </div>

        <div className="bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20 overflow-hidden">
          <table className="w-full text-body-sm">
            <thead className="bg-surface-container-low">
              <tr className="text-left">
                <th className="px-md py-sm">SKU</th><th className="px-md py-sm">Supplier</th>
                <th className="px-md py-sm">Design Link</th><th className="px-md py-sm">Ready</th>
                <th className="px-md py-sm">Source</th><th className="px-md py-sm">Updated</th><th className="px-md py-sm"></th>
              </tr>
            </thead>
            <tbody>
              {groups.map(group => group.rows.map((e, i) => (
                <tr key={e.id} className={`border-t ${i === 0 ? 'border-outline-variant/40' : 'border-outline-variant/10'}`}>
                  {i === 0 && (
                    <td rowSpan={group.rows.length} className="px-md py-sm font-medium align-top border-r border-outline-variant/20">{group.sku}</td>
                  )}
                  <td className="px-md py-sm">{e.supplier.name}</td>
                  <td className="px-md py-sm max-w-[320px] truncate">
                    {e.designLink ? <a className="text-primary underline" href={e.designLink} target="_blank" rel="noreferrer">{e.designLink}</a> : '—'}
                  </td>
                  <td className="px-md py-sm">
                    <button onClick={() => toggleReady(e)} className={`px-sm py-xs rounded-lg text-label-sm ${e.ready ? 'bg-emerald-100 text-emerald-900' : 'bg-amber-100 text-amber-900'}`}>
                      {e.ready ? 'Ready' : 'Not ready'}
                    </button>
                  </td>
                  <td className="px-md py-sm">{e.source}</td>
                  <td className="px-md py-sm">{new Date(e.updatedAt).toLocaleDateString('en-US')}</td>
                  <td className="px-md py-sm">
                    <button onClick={() => remove(e.id)} className="material-symbols-outlined text-error">delete</button>
                  </td>
                </tr>
              )))}
              {entries.length === 0 && <tr><td className="px-md py-lg text-on-surface-variant" colSpan={7}>Chưa có design nào.</td></tr>}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  )
}
