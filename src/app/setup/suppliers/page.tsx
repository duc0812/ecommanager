'use client'
import { useCallback, useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
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

const suggestedFulfillments = [
  { name: 'BurgerPrints', code: 'burgerprints', note: 'BurgerPrints fulfillment integration.' },
  { name: 'Customcat', code: 'customcat', note: 'Customcat fulfillment integration.' },
  { name: 'Dreamship', code: 'dreamship', note: 'Dreamship fulfillment integration.' },
  { name: 'Flashship', code: 'flashship', note: 'Flashship fulfillment integration.' },
]

function codeFromName(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

export default function SuppliersPage() {
  const pathname = usePathname()
  const basePath = pathname.startsWith('/fulfillment') ? '/fulfillment/suppliers' : '/setup/suppliers'
  const [list, setList] = useState<Supplier[]>([])
  const [showInactive, setShowInactive] = useState(false)
  const [form, setForm] = useState<typeof empty>(empty)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [error, setError] = useState('')
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
        code: form.code || codeFromName(form.name),
        firstItemShipFee: Number(form.firstItemShipFee),
        additionalItemShipFee: Number(form.additionalItemShipFee),
        preferenceRank: Number(form.preferenceRank),
        apiType: form.apiType || null,
        note: form.note || null,
      }),
    })
    const body = await res.json()
    if (!res.ok) { setError(body.error || 'Error'); setBusy(false); return }
    setForm(empty); setEditingId(null); setShowForm(false); setBusy(false)
    await load()
  }

  const installSuggested = async (item: { name: string; code: string; note: string }) => {
    const existing = list.find(s => s.code === item.code || s.name.toLowerCase() === item.name.toLowerCase())
    if (existing) {
      window.location.href = `${basePath}/${existing.id}`
      return
    }
    setBusy(true)
    const res = await fetch('/api/suppliers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: item.name,
        code: item.code,
        apiType: null,
        currency: 'USD',
        firstItemShipFee: 0,
        additionalItemShipFee: 0,
        preferenceRank: 0,
        note: item.note,
      }),
    })
    const created = await res.json()
    setBusy(false)
    if (!res.ok) { setError(created.error || 'Cannot create supplier'); return }
    window.location.href = `${basePath}/${created.id}`
  }

  const startEdit = (s: Supplier) => {
    setEditingId(s.id)
    setShowForm(true)
    setForm({
      name: s.name, code: s.code, apiType: s.apiType ?? '',
      firstItemShipFee: s.firstItemShipFee, additionalItemShipFee: s.additionalItemShipFee,
      currency: s.currency, preferenceRank: s.preferenceRank, note: s.note ?? '',
    })
  }

  const cancelEdit = () => { setEditingId(null); setForm(empty); setError(''); setShowForm(false) }

  const deactivate = async (id: string) => {
    if (!confirm('Deactivate this supplier?')) return
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

  const cards: Array<Supplier | { suggested: true; name: string; code: string; note: string }> = [
    ...list,
    ...suggestedFulfillments
      .filter(item => !list.some(s => s.code === item.code || s.name.toLowerCase() === item.name.toLowerCase()))
      .map(item => ({ suggested: true as const, ...item })),
  ]

  return (
    <div className="flex min-h-screen bg-surface">
      <Sidebar />
      <main className="ml-[280px] flex-1 p-xl">
        <div className="flex items-center justify-between mb-lg">
          <div>
            <h1 className="text-display-md">All Fulfillments</h1>
            <p className="text-body-sm text-on-surface-variant mt-xs">
              Chọn supplier trước, sau đó setup product/SKU sheet, cost, shipping và export template trong từng supplier.
            </p>
          </div>
          <div className="flex items-center gap-md">
            <label className="flex items-center gap-sm text-body-sm">
              <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} />
              Show inactive
            </label>
            <button onClick={() => { setShowForm(true); setEditingId(null); setForm(empty) }} className="bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md">
              Add custom supplier
            </button>
          </div>
        </div>

        {showForm && (
          <div className="bg-surface-container-lowest rounded-lg p-lg shadow-card border border-outline-variant/20 mb-lg">
            <h2 className="text-headline-sm mb-md">{editingId ? 'Edit supplier' : 'Add supplier'}</h2>
            {error && <p className="text-error text-body-sm mb-md">{error}</p>}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-md">
              <div>
                <label className="text-label-sm block mb-xs">Name *</label>
                <input className="w-full border rounded-lg px-sm py-xs" value={form.name} onChange={e => setForm({ ...form, name: e.target.value, code: form.code || codeFromName(e.target.value) })} />
              </div>
              <div>
                <label className="text-label-sm block mb-xs">Code * (unique)</label>
                <input className="w-full border rounded-lg px-sm py-xs font-mono" value={form.code} onChange={e => setForm({ ...form, code: e.target.value })} />
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
                <label className="text-label-sm block mb-xs">Default ship 1st</label>
                <input type="number" step="0.01" className="w-full border rounded-lg px-sm py-xs" value={form.firstItemShipFee} onChange={e => setForm({ ...form, firstItemShipFee: Number(e.target.value) })} />
              </div>
              <div>
                <label className="text-label-sm block mb-xs">Default ship add</label>
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
              <button onClick={save} disabled={busy || !form.name} className="bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md disabled:opacity-50">
                {busy ? 'Saving...' : (editingId ? 'Update' : 'Create')}
              </button>
              <button onClick={cancelEdit} className="px-lg py-sm rounded-lg text-label-md border">Cancel</button>
            </div>
          </div>
        )}

        <div className="space-y-md">
          {cards.map(card => {
            const isSuggested = 'suggested' in card
            const supplier = isSuggested ? null : card
            return (
              <div key={card.code} className={`bg-surface-container-lowest rounded-lg border border-outline-variant/30 p-lg shadow-card ${supplier && !supplier.isActive ? 'opacity-60' : ''}`}>
                <div className="flex items-start justify-between gap-lg">
                  <div>
                    <h2 className="text-headline-sm">{card.name}</h2>
                    <p className="text-body-sm text-on-surface-variant mt-md">
                      {isSuggested ? card.note : (card.note || `${card.name} fulfillment setup.`)}
                    </p>
                    {!isSuggested && (
                      <div className="flex flex-wrap gap-md mt-md text-label-sm text-on-surface-variant">
                        <span>Products: {supplier!._count.products}</span>
                        <span>Templates: {supplier!._count.templates}</span>
                        <span>Ship: ${supplier!.firstItemShipFee.toFixed(2)} / ${supplier!.additionalItemShipFee.toFixed(2)}</span>
                        <span>Status: {supplier!.isActive ? 'active' : 'inactive'}</span>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-sm">
                    {isSuggested ? (
                      <button onClick={() => installSuggested(card)} disabled={busy} className="bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md disabled:opacity-50">
                        Install
                      </button>
                    ) : (
                      <>
                        <a href={`${basePath}/${supplier!.id}`} className="bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md">
                          Setup
                        </a>
                        <button onClick={() => startEdit(supplier!)} className="px-md py-sm rounded-lg border text-label-md">Edit</button>
                        {supplier!.isActive
                          ? <button onClick={() => deactivate(supplier!.id)} className="px-md py-sm rounded-lg border border-error text-error text-label-md">Deactivate</button>
                          : <button onClick={() => reactivate(supplier!)} className="px-md py-sm rounded-lg border text-label-md">Activate</button>
                        }
                      </>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
          {cards.length === 0 && (
            <div className="bg-surface-container-lowest rounded-lg border border-outline-variant/30 p-xl text-center text-on-surface-variant">
              No suppliers yet.
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
