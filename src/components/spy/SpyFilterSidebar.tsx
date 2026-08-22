'use client'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'

type FiltersData = { domains: string[]; niches: { id: string; name: string }[]; productTypes: { id: string; name: string }[] }

function Facet({ title, options, value, onPick }: { title: string; options: { key: string | null; label: string }[]; value: string | null; onPick: (v: string | null) => void }) {
  return (
    <div className="mb-md">
      <p className="mb-xs px-xs text-label-sm uppercase tracking-wider text-on-surface-variant">{title}</p>
      {options.map(o => {
        const active = (o.key ?? null) === value
        return (
          <button key={o.key ?? '__all'} onClick={() => onPick(o.key)}
            className={`flex w-full items-center rounded-lg px-md py-xs text-left text-body-sm ${active ? 'bg-secondary-fixed font-semibold text-primary' : 'text-on-surface hover:bg-surface-container-low'}`}>{o.label}</button>
        )
      })}
    </div>
  )
}

export default function SpyFilterSidebar() {
  const pathname = usePathname()
  const router = useRouter()
  const params = useSearchParams()
  const [filters, setFilters] = useState<FiltersData>({ domains: [], niches: [], productTypes: [] })

  useEffect(() => { fetch('/api/spy/filters', { cache: 'no-store' }).then(r => r.json()).then(setFilters).catch(() => {}) }, [])

  function setParam(key: string, value: string | null) {
    const p = new URLSearchParams(Array.from(params.entries()))
    if (value) p.set(key, value); else p.delete(key)
    router.replace(`/tools/spy-idea?${p.toString()}`)
  }

  return (
    <aside className="sticky top-md w-[220px] flex-none self-start rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-md shadow-card">
      <Facet title="Domain" value={params.get('domain')} onPick={v => setParam('domain', v)} options={[{ key: null, label: 'All' }, ...filters.domains.map(d => ({ key: d, label: d }))]} />
      <Facet title="Niche" value={params.get('niche')} onPick={v => setParam('niche', v)} options={[{ key: null, label: 'All' }, ...filters.niches.map(n => ({ key: n.id, label: n.name }))]} />
      <Facet title="Product type" value={params.get('type')} onPick={v => setParam('type', v)} options={[{ key: null, label: 'All' }, ...filters.productTypes.map(t => ({ key: t.id, label: t.name }))]} />
      <div className="my-md h-px bg-outline-variant/40" />
      <div>
        <p className="mb-xs px-xs text-label-sm uppercase tracking-wider text-on-surface-variant">Setup</p>
        {[
          { href: '/tools/spy-idea/sources', icon: 'storefront', label: 'Sources' },
          { href: '/tools/spy-idea/niches', icon: 'sell', label: 'Niche' },
          { href: '/tools/spy-idea/product-types', icon: 'category', label: 'Product type' },
        ].map(s => {
          const active = pathname === s.href
          return (
            <Link key={s.href} href={s.href} className={`flex items-center gap-sm rounded-lg px-md py-xs text-body-sm ${active ? 'bg-secondary-fixed font-semibold text-primary' : 'text-secondary hover:bg-surface-container-low'}`}>
              <span className="material-symbols-outlined text-[18px]">{s.icon}</span>{s.label}
            </Link>
          )
        })}
      </div>
    </aside>
  )
}
