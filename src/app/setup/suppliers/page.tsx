'use client'
import { useCallback, useEffect, useState } from 'react'
import Sidebar from '@/components/Sidebar'

type Supplier = {
  id: string
  name: string
  code: string
  apiType: string | null
  firstItemShipFee: number
  additionalItemShipFee: number
  currency: string
  preferenceRank: number
  note: string | null
  isActive: boolean
  _count: { products: number; templates: number }
}

const empty = {
  name: '', code: '', apiType: '',
  firstItemShipFee: 0, additionalItemShipFee: 0,
  currency: 'USD', preferenceRank: 0, note: '',
}

export default function SuppliersPage() {
  const [list, setList] = useState<Supplier[]>([])
  const [showInactive, setShowInactive] = useState(false)
  const [form, setForm] = useState<typeof empty>(empty)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [error, setError] = useState<string>('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const r = await fetch(`/api/suppliers${showInactive ? '?includeInactive=1' : ''}`)
    const data = await r.json()
    setList(data.suppliers ?? [])
  }, [showInactive])
  useEffect(() => { load() }, [load])

  const save = async () => {
    setBusy(true); setError('')
    const url = editingId ? `/api/suppliers/${editingId}` : '/api/suppliers'
    const method = editingId ? 'PATCH' : 'POST'
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...form,
        firstItemShipFee: Number(form.firstItemShipFee),
        additionalItemShipFee: Number(form.additionalItemShipFee),
        preferenceRank: Number(form.preferenceRank),
        apiType: form.apiType || null,
        note: form.note || null,
      }),
    })
    const body = await res.json()
    if (!res.ok) { setError(body.error || 'Error'); setBusy(false); return }
    setForm(empty); setEditingId(null); setBusy(false)
    await load()
  }

  const startEdit = (s: Supplier) => {
    setEditingId(s.id)
    setForm({
      name: s.name, code: s.code, apiType: s.apiType ?? '',
      firstItemShipFee: s.firstItemShipFee, additionalItemShipFee: s.additionalItemShipFee,
      currency: s.currency, preferenceRank: s.preferenceRank, note: s.note ?? '',
    })
  }

  const cancelEdit = () => { setEditingId(null); setForm(empty); setError('') }

  const deactivate = async (id: string) => {
    if (!confirm('Deactivate this supplier? (Soft delete — can be reactivated.)')) return
    await fetch(`/api/suppliers/${id}`, { method: 'DELETE' })
    await load()
  }

  const reactivate = async (s: Supplier) => {
    await fetch(`/api/suppliers/${s.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: true }),
    })
    await load()
  }

  return (
    <div className="flex min-h-screen bg-surface">
      <Sidebar />
      <main className="ml-[280px] flex-1 p-xl">
        <div className="flex items-center justify-between mb-lg">
          <h1 className="text-display-md">Suppliers</h1>
          <label className="flex items-center gap-sm text-body-sm">
            <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} />
            Show inactive
          </label>
        </div>

        {/* Form */}
        <div className="bg-surface-container-lowest rounded-xl p-lg shadow-card border border-outline-variant/20 mb-lg">
          <h2 className="text-headline-sm mb-md">{editingId ? 'Edit supplier' : 'Add supplier'}</h2>
          {error && <p className="text-error text-body-sm mb-md">⚠ {error}</p>}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-md">
            <div>
              <label className="text-label-sm block mb-xs">Name *</label>
              <input className="w-full border rounded-lg px-sm py-xs" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
            </div>
            <div>
              <label className="text-label-sm block mb-xs">Code * (unique)</label>
              <input className="w-full border rounded-lg px-sm py-xs font-mono" value={form.code} onChange={e => setForm({ ...form, code: e.target.value })} placeholder="printful" />
            </div>
            <div>
              <label className="text-label-sm block mb-xs">API type</label>
              <select className="w-full border rounded-lg px-sm py-xs" value={form.apiType} onChange={e => setForm({ ...form, apiType: e.target.value })}>
                <option value="">None (manual)</option>
                <option value="printful">Printful</option>
                <option value="printify">Printify</option>
              </select>
            </div>
            <div>
              <label className="text-label-sm block mb-xs">Currency</label>
              <input className="w-full border rounded-lg px-sm py-xs" value={form.currency} onChange={e => setForm({ ...form, currency: e.target.value })} />
            </div>
            <div>
              <label className="text-label-sm block mb-xs">First item ship fee</label>
              <input type="number" step="0.01" className="w-full border rounded-lg px-sm py-xs" value={form.firstItemShipFee} onChange={e => setForm({ ...form, firstItemShipFee: Number(e.target.value) })} />
            </div>
            <div>
              <label className="text-label-sm block mb-xs">Additional item ship fee</label>
              <input type="number" step="0.01" className="w-full border rounded-lg px-sm py-xs" value={form.additionalItemShipFee} onChange={e => setForm({ ...form, additionalItemShipFee: Number(e.target.value) })} />
            </div>
            <div>
              <label className="text-label-sm block mb-xs">Preference rank</label>
              <input type="number" className="w-full border rounded-lg px-sm py-xs" value={form.preferenceRank} onChange={e => setForm({ ...form, preferenceRank: Number(e.target.value) })} />
            </div>
            <div className="col-span-2 md:col-span-4">
              <label className="text-label-sm block mb-xs">Note</label>
              <input className="w-full border rounded-lg px-sm py-xs" value={form.note} onChange={e => setForm({ ...form, note: e.target.value })} />
            </div>
          </div>
          <div className="mt-md flex gap-sm">
            <button onClick={save} disabled={busy} className="bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md disabled:opacity-50">
              {busy ? 'Saving…' : (editingId ? 'Update' : 'Create')}
            </button>
            {editingId && <button onClick={cancelEdit} className="px-lg py-sm rounded-lg text-label-md border">Cancel</button>}
          </div>
        </div>

        {/* List */}
        <div className="bg-surface-container-lowest rounded-xl border border-outline-variant/20 overflow-hidden">
          <table className="w-full text-body-sm">
            <thead className="bg-surface-container">
              <tr className="text-left">
                <th className="px-md py-sm">Name</th>
                <th className="px-md py-sm">Code</th>
                <th className="px-md py-sm">API</th>
                <th className="px-md py-sm text-right">Ship 1st / Add</th>
                <th className="px-md py-sm">Currency</th>
                <th className="px-md py-sm text-right">Rank</th>
                <th className="px-md py-sm text-right">Products</th>
                <th className="px-md py-sm text-right">Templates</th>
                <th className="px-md py-sm">Status</th>
                <th className="px-md py-sm"></th>
              </tr>
            </thead>
            <tbody>
              {list.map(s => (
                <tr key={s.id} className={`border-t border-outline-variant/20 ${!s.isActive ? 'opacity-50' : ''}`}>
                  <td className="px-md py-sm">{s.name}</td>
                  <td className="px-md py-sm font-mono">{s.code}</td>
                  <td className="px-md py-sm">{s.apiType ?? '—'}</td>
                  <td className="px-md py-sm text-right">${s.firstItemShipFee.toFixed(2)} / ${s.additionalItemShipFee.toFixed(2)}</td>
                  <td className="px-md py-sm">{s.currency}</td>
                  <td className="px-md py-sm text-right">{s.preferenceRank}</td>
                  <td className="px-md py-sm text-right">{s._count.products}</td>
                  <td className="px-md py-sm text-right">{s._count.templates}</td>
                  <td className="px-md py-sm">{s.isActive ? 'active' : 'inactive'}</td>
                  <td className="px-md py-sm">
                    <div className="flex gap-xs">
                      <a href={`/setup/suppliers/${s.id}/templates`} className="text-secondary text-label-sm">Templates</a>
                      <button onClick={() => startEdit(s)} className="text-secondary text-label-sm">Edit</button>
                      {s.isActive
                        ? <button onClick={() => deactivate(s.id)} className="text-error text-label-sm">Deactivate</button>
                        : <button onClick={() => reactivate(s)} className="text-secondary text-label-sm">Activate</button>
                      }
                    </div>
                  </td>
                </tr>
              ))}
              {list.length === 0 && <tr><td colSpan={10} className="px-md py-lg text-center text-on-surface-variant">No suppliers yet. Add one above.</td></tr>}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  )
}
