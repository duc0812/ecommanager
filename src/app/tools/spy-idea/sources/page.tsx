'use client'
import { useEffect, useState, useCallback } from 'react'
import type { SpyCronConfig } from '@/lib/spy/cron-config'

type Store = { id: string; domain: string; name: string | null; status: string; _count?: { products: number } }
type AdDomain = { id: string; domain: string; searchTerm: string; country: string; lastScanAt: string | null; pageCount: number; adCount: number; newAdCount: number }
type PageTarget = { id: string; pageUrl: string; label: string | null; lastScanAt: string | null; excluded?: boolean }
type Quota = { isAdmin: boolean; used: number; limit: number; remaining: number | null }

function DomainBlock({ domain, onScan, onRemove, onChanged }: { domain: AdDomain; onScan: () => void; onRemove: () => void; onChanged: () => void }) {
  const [pages, setPages] = useState<PageTarget[]>([])
  const [pageUrl, setPageUrl] = useState('')
  const [term, setTerm] = useState(domain.searchTerm)

  async function load() {
    setPages(await fetch(`/api/spy/pages?adDomainId=${domain.id}`).then(r => r.json()))
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
  async function toggleExclude(id: string, excluded: boolean) {
    await fetch('/api/spy/pages', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, excluded }) })
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
              <span className={`text-body-sm text-primary ${p.excluded ? 'opacity-50' : ''}`}>{p.label ?? p.pageUrl}</span>
              <span className="flex items-center gap-md">
                <button onClick={() => scanPage(p.id)} className="text-secondary text-label-sm hover:underline">Scan page</button>
                <label className="flex items-center gap-xs text-label-sm text-on-surface-variant">
                  <input type="checkbox" checked={!!p.excluded} onChange={e => toggleExclude(p.id, e.target.checked)} />
                  Exclude
                </label>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

const HOURS = Array.from({ length: 24 }, (_, i) => i)

function CronCard() {
  const [cfg, setCfg] = useState<SpyCronConfig | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    fetch('/api/spy/cron').then(r => r.json()).then(setCfg)
  }, [])

  function toggleEnabled(group: keyof SpyCronConfig) {
    if (!cfg) return
    setCfg({ ...cfg, [group]: { ...cfg[group], enabled: !cfg[group].enabled } })
  }

  function toggleHour(group: keyof SpyCronConfig, h: number) {
    if (!cfg) return
    const hours = cfg[group].hours.includes(h)
      ? cfg[group].hours.filter(x => x !== h)
      : [...cfg[group].hours, h].sort((a, b) => a - b)
    setCfg({ ...cfg, [group]: { ...cfg[group], hours } })
  }

  async function save() {
    if (!cfg) return
    setSaving(true)
    try {
      const res = await fetch('/api/spy/cron', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) })
      const saved = await res.json()
      setCfg(saved)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } finally {
      setSaving(false)
    }
  }

  if (!cfg) return <div className="mb-xl rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-lg text-body-sm text-on-surface-variant">Loading cron config…</div>

  const groups: { key: keyof SpyCronConfig; label: string }[] = [
    { key: 'productBestSeller', label: 'Product + Best Seller' },
    { key: 'ads', label: 'Ads' },
  ]

  return (
    <section className="mb-xl rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-lg">
      <div className="mb-md flex items-center justify-between">
        <div>
          <h3 className="text-headline-sm text-primary">Scheduled scans (cron)</h3>
          <p className="text-body-sm text-on-surface-variant">Timezone: Asia/Ho_Chi_Minh</p>
        </div>
        <button onClick={save} disabled={saving} className="rounded-lg bg-secondary px-lg py-sm text-label-md text-on-secondary disabled:opacity-50">
          {saved ? 'Saved ✓' : saving ? 'Saving…' : 'Save'}
        </button>
      </div>
      <div className="space-y-lg">
        {groups.map(({ key, label }) => (
          <div key={key}>
            <label className="mb-sm flex items-center gap-sm">
              <input type="checkbox" checked={cfg[key].enabled} onChange={() => toggleEnabled(key)} className="h-4 w-4 accent-secondary" />
              <span className="text-label-md text-on-surface">{label}</span>
            </label>
            <div className="flex flex-wrap gap-xs">
              {HOURS.map(h => {
                const active = cfg[key].hours.includes(h)
                return (
                  <button
                    key={h}
                    onClick={() => toggleHour(key, h)}
                    className={`rounded px-sm py-xs text-label-sm transition-colors ${active ? 'bg-secondary text-on-secondary' : 'bg-surface-container text-on-surface-variant hover:bg-surface-container-high'}`}
                  >
                    {String(h).padStart(2, '0')}
                  </button>
                )
              })}
            </div>
          </div>
        ))}
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
  const [quota, setQuota] = useState<Quota | null>(null)
  const [storeScanning, setStoreScanning] = useState<Record<string, boolean>>({})
  const [storeScanMsg, setStoreScanMsg] = useState<Record<string, string>>({})

  const loadQuota = useCallback(async () => {
    const res = await fetch('/api/spy/scan-quota')
    if (res.ok) setQuota(await res.json())
  }, [])

  async function loadStores() { setStores(await fetch('/api/spy/stores').then(r => r.json())) }
  async function loadAdDomains() { setAdDomains(await fetch('/api/spy/ad-domains').then(r => r.json())) }

  useEffect(() => { loadStores(); loadAdDomains(); loadQuota() }, [loadQuota])

  const quotaExhausted = quota !== null && !quota.isAdmin && quota.remaining !== null && quota.remaining <= 0

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
    try {
      await fetch('/api/spy/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })
      await loadStores()
      await loadQuota()
    } finally { setScanning(false) }
  }
  async function scanStore(id: string) {
    setStoreScanning(p => ({ ...p, [id]: true }))
    setStoreScanMsg(p => ({ ...p, [id]: '' }))
    try {
      const res = await fetch('/api/spy/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ storeId: id }) })
      if (res.status === 429) {
        const body = await res.json()
        setStoreScanMsg(p => ({ ...p, [id]: `Hết lượt hôm nay (${body.used}/${body.limit})` }))
      } else {
        await loadStores()
      }
      await loadQuota()
    } finally {
      setStoreScanning(p => ({ ...p, [id]: false }))
    }
  }
  async function addAdDomain() {
    if (!domainInput.trim()) return
    await fetch('/api/spy/ad-domains', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ domain: domainInput }) })
    setDomainInput(''); loadAdDomains()
  }
  async function scanDomain(id: string) {
    await fetch('/api/spy/scan-ads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ domainId: id }) })
    setTimeout(() => { loadAdDomains(); loadQuota() }, 30000)
  }
  async function removeAdDomain(id: string) {
    await fetch('/api/spy/ad-domains', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })
    loadAdDomains()
  }

  return (
    <>
      <header className="mb-lg">
        <p className="text-label-sm uppercase tracking-wider text-on-surface-variant">Tools · Spy · Setup</p>
        <h2 className="text-display-md font-bold text-primary">Sources</h2>
      </header>

      <div className="mb-lg flex items-center gap-sm">
        {quota && (
          <span className={`inline-flex items-center gap-xs rounded-full px-md py-xs text-label-sm ${quota.isAdmin ? 'bg-secondary/10 text-secondary' : quotaExhausted ? 'bg-error/10 text-error' : 'bg-surface-container text-on-surface-variant'}`}>
            <span className="material-symbols-outlined text-[16px]">{quota.isAdmin ? 'admin_panel_settings' : 'data_usage'}</span>
            {quota.isAdmin ? 'Admin · không giới hạn' : `Đã dùng ${quota.used}/${quota.limit} lượt scan hôm nay`}
          </span>
        )}
      </div>

      <CronCard />

      <section className="mb-xl rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-lg">
        <h3 className="mb-md text-headline-sm text-primary">Shopify stores</h3>
        <div className="mb-md flex gap-sm">
          <input value={domain} onChange={e => setDomain(e.target.value)} placeholder="store.myshopify.com"
            className="flex-1 rounded-lg border border-outline-variant/30 bg-surface-container px-md py-sm text-body-md outline-none focus:border-secondary" />
          <button onClick={addStore} className="rounded-lg bg-secondary px-lg py-sm text-label-md text-on-secondary">Add store</button>
          <button
            onClick={scanAll}
            disabled={scanning || quotaExhausted}
            title={quotaExhausted ? 'Hết lượt hôm nay' : undefined}
            className="rounded-lg bg-primary px-lg py-sm text-label-md text-on-primary disabled:opacity-50"
          >
            {scanning ? 'Scanning…' : 'Scan now'}
          </button>
        </div>
        <ul className="divide-y divide-outline-variant/20">
          {stores.map(s => (
            <li key={s.id} className="flex items-center justify-between py-sm">
              <div>
                <p className="text-label-md text-primary">{s.domain}</p>
                <p className="text-body-sm text-on-surface-variant">{s._count?.products ?? 0} products · {s.status}</p>
                {storeScanMsg[s.id] && <p className="text-body-sm text-error">{storeScanMsg[s.id]}</p>}
              </div>
              <span className="flex items-center gap-sm">
                <button
                  onClick={() => scanStore(s.id)}
                  disabled={storeScanning[s.id] || quotaExhausted}
                  title={quotaExhausted ? 'Hết lượt hôm nay' : undefined}
                  className="rounded-lg bg-primary px-md py-xs text-label-sm text-on-primary disabled:opacity-50"
                >
                  {storeScanning[s.id] ? 'Scanning…' : 'Scan'}
                </button>
                <button onClick={() => removeStore(s.id)} className="text-error text-label-sm hover:underline">Remove</button>
              </span>
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
    </>
  )
}
