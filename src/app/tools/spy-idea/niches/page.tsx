'use client'
import { useEffect, useState } from 'react'
import Sidebar from '@/components/Sidebar'
import { RoleGate } from '@/components/RoleGate'
import SpySectionNav from '@/components/SpySectionNav'

type Niche = { id: string; name: string; keywords: string; active: boolean }

const NAV_ITEMS = [
  { key: 'dashboard', label: 'Dashboard', icon: 'space_dashboard', href: '/tools/spy-idea/dashboard' },
  { key: 'ads', label: 'Ad Library', icon: 'library_books', href: '/tools/spy-idea?tab=ads' },
  { key: 'products', label: 'Products', icon: 'inventory_2', href: '/tools/spy-idea?tab=products' },
  { key: 'stores', label: 'Stores', icon: 'storefront', href: '/tools/spy-idea?tab=stores' },
  { key: 'ideas', label: 'Ideas', icon: 'lightbulb', href: '/tools/spy-idea?tab=ideas' },
  { key: 'niches', label: 'Niches', icon: 'sell', href: '/tools/spy-idea/niches' },
]

function parseKw(json: string): string[] {
  try { const a = JSON.parse(json); return Array.isArray(a) ? a.map(String) : [] } catch { return [] }
}

export default function NichesPage() {
  const [niches, setNiches] = useState<Niche[]>([])
  const [name, setName] = useState('')
  const [keywords, setKeywords] = useState('')

  async function load() { setNiches(await fetch('/api/spy/niches').then(r => r.json())) }
  useEffect(() => { load() }, [])

  async function addNiche() {
    if (!name.trim()) return
    await fetch('/api/spy/niches', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, keywords }) })
    setName(''); setKeywords(''); load()
  }
  async function saveKeywords(id: string, kw: string) {
    await fetch('/api/spy/niches', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, keywords: kw }) })
    load()
  }
  async function removeNiche(id: string) {
    await fetch('/api/spy/niches', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })
    load()
  }

  return (
    <RoleGate>
      <div className="flex min-h-screen bg-surface">
        <Sidebar />
        <main className="ml-[280px] flex-1 p-xl">
          <header className="mb-lg">
            <p className="text-label-sm uppercase tracking-wider text-on-surface-variant">Tools</p>
            <h2 className="text-display-md font-bold text-primary">Niches</h2>
          </header>
          <SpySectionNav active="niches" items={NAV_ITEMS} />

          <section className="mb-xl rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-lg">
            <div className="grid grid-cols-1 gap-md md:grid-cols-[1fr_2fr_auto]">
              <input value={name} onChange={e => setName(e.target.value)} placeholder="Niche name (e.g. Disney)"
                className="rounded-lg border border-outline-variant/30 bg-surface-container px-md py-sm text-body-md outline-none focus:border-secondary" />
              <input value={keywords} onChange={e => setKeywords(e.target.value)} placeholder="keywords: dsny, disney, mickey"
                className="rounded-lg border border-outline-variant/30 bg-surface-container px-md py-sm text-body-md outline-none focus:border-secondary" />
              <button onClick={addNiche} className="rounded-lg bg-secondary px-lg py-sm text-label-md text-on-secondary">Add niche</button>
            </div>
            <p className="mt-xs text-body-sm text-on-surface-variant">Keywords match product titles and ad title/body (case-insensitive, any keyword).</p>
          </section>

          <ul className="space-y-sm">
            {niches.map(n => (
              <NicheRow key={n.id} niche={n} onSave={saveKeywords} onRemove={removeNiche} />
            ))}
            {niches.length === 0 && <p className="text-body-md text-on-surface-variant">No niches yet.</p>}
          </ul>
        </main>
      </div>
    </RoleGate>
  )
}

function NicheRow({ niche, onSave, onRemove }: { niche: Niche; onSave: (id: string, kw: string) => void; onRemove: (id: string) => void }) {
  const [kw, setKw] = useState(parseKw(niche.keywords).join(', '))
  return (
    <li className="flex flex-wrap items-center gap-sm rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-md">
      <span className="text-label-md font-bold text-primary">{niche.name}</span>
      <input value={kw} onChange={e => setKw(e.target.value)}
        className="min-w-[240px] flex-1 rounded-lg border border-outline-variant/30 bg-surface-container px-md py-xs text-body-sm" />
      <button onClick={() => onSave(niche.id, kw)} className="rounded-lg bg-surface-container px-md py-xs text-label-sm">Save</button>
      <button onClick={() => onRemove(niche.id)} className="text-error text-label-sm hover:underline">Xoá</button>
    </li>
  )
}
