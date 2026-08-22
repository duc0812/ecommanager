'use client'
import { useEffect, useState } from 'react'
import Sidebar from '@/components/Sidebar'
import { RoleGate } from '@/components/RoleGate'
import AdCard, { Ad } from '@/components/spy/AdCard'

type Store = { id: string; domain: string; name: string | null; status: string; _count?: { products: number } }
type AdDomain = { id: string; domain: string; searchTerm: string; country: string; lastScanAt: string | null; pageCount: number; adCount: number; newAdCount: number }
type PageTarget = { id: string; pageUrl: string; label: string | null; lastScanAt: string | null }

function DomainBlock({ domain, onScan, onRemove, onChanged }: { domain: AdDomain; onScan: () => void; onRemove: () => void; onChanged: () => void }) {
  const [pages, setPages] = useState<PageTarget[]>([])
  const [ads, setAds] = useState<Ad[]>([])
  const [pageUrl, setPageUrl] = useState('')
  const [term, setTerm] = useState(domain.searchTerm)

  async function load() {
    setPages(await fetch(`/api/spy/pages?adDomainId=${domain.id}`).then(r => r.json()))
    const d = await fetch(`/api/spy/ads?domainId=${domain.id}`).then(r => r.json()); setAds(d.ads ?? [])
  }
  useEffect(() => { load() }, [domain.id]) // eslint-disable-line react-hooks/exhaustive-deps

  async function saveTerm() {
    await fetch('/api/spy/ad-domains', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: domain.id, searchTerm: term }) })
    onChanged()
  }
  async function addPage() {
    if (!pageUrl.trim()) return
    await fetch('/api/spy/pages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pageUrl, adDomainId: domain.id }) })
    setPageUrl(''); load()
  }
  async function scanPage(id: string) {
    await fetch('/api/spy/scan-ads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pageId: id }) })
    setTimeout(load, 30000)
  }
  async function removePage(id: string) {
    await fetch('/api/spy/pages', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })
    load()
  }

  return (
    <section className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-lg">
      <div className="mb-md flex flex-wrap items-center gap-sm">
        <h3 className="text-headline-sm text-primary">{domain.domain}</h3>
        <span className="text-body-sm text-on-surface-variant">{domain.pageCount} pages · {domain.adCount} ads · {domain.newAdCount} new</span>
        <input value={term} onChange={e => setTerm(e.target.value)} className="ml-auto w-48 rounded-lg border border-outline-variant/30 bg-surface-container px-md py-xs text-body-sm" />
        <button onClick={saveTerm} className="rounded-lg bg-surface-container px-md py-xs text-label-sm">Save term</button>
        <button onClick={onScan} className="rounded-lg bg-primary px-md py-xs text-label-sm text-on-primary">Scan domain</button>
        <button onClick={onRemove} className="text-error text-label-sm hover:underline">Xoá</button>
      </div>
      <div className="mb-md">
        <p className="mb-xs text-label-sm uppercase tracking-wider text-on-surface-variant">Fanpages</p>
        <div className="mb-sm flex gap-sm">
          <input value={pageUrl} onChange={e => setPageUrl(e.target.value)} placeholder="https://www.facebook.com/BrandPage"
            className="flex-1 rounded-lg border border-outline-variant/30 bg-surface-container px-md py-sm text-body-sm outline-none focus:border-secondary" />
          <button onClick={addPage} className="rounded-lg bg-secondary px-lg py-sm text-label-sm text-on-secondary">Add fanpage</button>
        </div>
        <ul className="divide-y divide-outline-variant/20">
          {pages.map(p => (
            <li key={p.id} className="flex items-center justify-between py-xs">
              <span className="text-body-sm text-primary">{p.label ?? p.pageUrl}</span>
              <span className="flex items-center gap-md">
                <button onClick={() => scanPage(p.id)} className="text-secondary text-label-sm hover:underline">Scan page</button>
                <button onClick={() => removePage(p.id)} className="text-error text-label-sm hover:underline">Xoá</button>
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div className="grid grid-cols-1 gap-md sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {ads.map(a => <AdCard key={a.id} a={a} onSave={() => {}} />)}
        {ads.length === 0 && <p className="text-body-md text-on-surface-variant">No ads yet — scan the domain or a fanpage.</p>}
      </div>
    </section>
  )
}

export default function SourcesPage() {
  const [stores, setStores] = useState<Store[]>([])
  const [adDomains, setAdDomains] = useState<AdDomain[]>([])
  const [domain, setDomain] = useState('')
  const [domainInput, setDomainInput] = useState('')
  const [scanning, setScanning] = useState(false)

  async function loadStores() { setStores(await fetch('/api/spy/stores').then(r => r.json())) }
  async function loadAdDomains() { setAdDomains(await fetch('/api/spy/ad-domains').then(r => r.json())) }
  useEffect(() => { loadStores(); loadAdDomains() }, [])

  async function addStore() {
    if (!domain.trim()) return
    await fetch('/api/spy/stores', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ domain }) })
    setDomain(''); loadStores()
  }
  async function removeStore(id: string) {
    await fetch('/api/spy/stores', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })
    loadStores()
  }
  async function scanAll() {
    setScanning(true)
    try { await fetch('/api/spy/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }); await loadStores() }
    finally { setScanning(false) }
  }
  async function addAdDomain() {
    if (!domainInput.trim()) return
    await fetch('/api/spy/ad-domains', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ domain: domainInput }) })
    setDomainInput(''); loadAdDomains()
  }
  async function scanDomain(id: string) {
    await fetch('/api/spy/scan-ads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ domainId: id }) })
    setTimeout(loadAdDomains, 30000)
  }
  async function removeAdDomain(id: string) {
    await fetch('/api/spy/ad-domains', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })
    loadAdDomains()
  }

  return (
    <RoleGate>
      <div className="flex min-h-screen bg-surface">
        <Sidebar />
        <main className="ml-[280px] flex-1 p-xl">
          <header className="mb-lg">
            <p className="text-label-sm uppercase tracking-wider text-on-surface-variant">Tools · Spy · Setup</p>
            <h2 className="text-display-md font-bold text-primary">Sources</h2>
          </header>

          <section className="mb-xl rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-lg">
            <h3 className="mb-md text-headline-sm text-primary">Shopify stores</h3>
            <div className="mb-md flex gap-sm">
              <input value={domain} onChange={e => setDomain(e.target.value)} placeholder="store.myshopify.com"
                className="flex-1 rounded-lg border border-outline-variant/30 bg-surface-container px-md py-sm text-body-md outline-none focus:border-secondary" />
              <button onClick={addStore} className="rounded-lg bg-secondary px-lg py-sm text-label-md text-on-secondary">Add store</button>
              <button onClick={scanAll} disabled={scanning} className="rounded-lg bg-primary px-lg py-sm text-label-md text-on-primary disabled:opacity-50">{scanning ? 'Scanning…' : 'Scan now'}</button>
            </div>
            <ul className="divide-y divide-outline-variant/20">
              {stores.map(s => (
                <li key={s.id} className="flex items-center justify-between py-sm">
                  <div><p className="text-label-md text-primary">{s.domain}</p><p className="text-body-sm text-on-surface-variant">{s._count?.products ?? 0} products · {s.status}</p></div>
                  <button onClick={() => removeStore(s.id)} className="text-error text-label-sm hover:underline">Remove</button>
                </li>
              ))}
            </ul>
          </section>

          <section className="mb-md rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-lg">
            <h3 className="mb-md text-headline-sm text-primary">Ad domains</h3>
            <div className="flex gap-sm">
              <input value={domainInput} onChange={e => setDomainInput(e.target.value)} placeholder="familystore.com"
                className="flex-1 rounded-lg border border-outline-variant/30 bg-surface-container px-md py-sm text-body-md outline-none focus:border-secondary" />
              <button onClick={addAdDomain} className="rounded-lg bg-secondary px-lg py-sm text-label-md text-on-secondary">Add domain</button>
            </div>
          </section>

          <div className="space-y-lg">
            {adDomains.map(d => <DomainBlock key={d.id} domain={d} onScan={() => scanDomain(d.id)} onRemove={() => removeAdDomain(d.id)} onChanged={loadAdDomains} />)}
          </div>
        </main>
      </div>
    </RoleGate>
  )
}
