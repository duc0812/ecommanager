'use client'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { FILTERS_CHANGED } from '@/lib/spy/filter-events'

type FiltersData = { domains: string[]; niches: { id: string; name: string }[]; productTypes: { id: string; name: string }[] }

function Facet({ title, options, value, onPick }: { title: string; options: { key: string | null; label: string }[]; value: string | null; onPick: (v: string | null) => void }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="px-[10px] font-[family-name:var(--font-plex-mono)] text-[10px] uppercase tracking-[0.12em] text-[#78716C]">{title}</div>
      <div className="flex flex-col gap-[1px]">
        {options.map(o => {
          const active = (o.key ?? null) === value
          return (
            <button key={o.key ?? '__all'} onClick={() => onPick(o.key)}
              className={`flex w-full items-center rounded-[8px] px-[10px] py-[8px] text-left text-[13px] transition-colors ${active ? 'bg-[#F0EFFB] font-semibold text-[#3F3AC4]' : 'text-[#57534E] hover:bg-[#F2F1EE]'}`}>
              <span className="truncate">{o.label}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

export default function SpyFilterSidebar() {
  const pathname = usePathname()
  const router = useRouter()
  const params = useSearchParams()
  const [filters, setFilters] = useState<FiltersData>({ domains: [], niches: [], productTypes: [] })

  useEffect(() => {
    const load = () => fetch('/api/spy/filters', { cache: 'no-store' }).then(r => r.json()).then(setFilters).catch(() => {})
    load()
    window.addEventListener(FILTERS_CHANGED, load)
    return () => window.removeEventListener(FILTERS_CHANGED, load)
  }, [])

  function setParam(key: string, value: string | null) {
    const p = new URLSearchParams(Array.from(params.entries()))
    if (value) p.set(key, value); else p.delete(key)
    router.replace(`/tools/spy-idea?${p.toString()}`)
  }

  const setupLinks = [
    { href: '/tools/spy-idea/sources', icon: 'storefront', label: 'Sources' },
    { href: '/tools/spy-idea/niches', icon: 'sell', label: 'Niche' },
    { href: '/tools/spy-idea/product-types', icon: 'category', label: 'Product type' },
  ]

  return (
    <aside className="sticky top-0 flex h-screen w-[268px] flex-none flex-col gap-[28px] overflow-y-auto border-r border-[#E6E3DE] bg-white px-[20px] py-[24px]">
      <Facet title="Domain" value={params.get('domain')} onPick={v => setParam('domain', v)} options={[{ key: null, label: 'All' }, ...filters.domains.map(d => ({ key: d, label: d }))]} />
      <Facet title="Niche" value={params.get('niche')} onPick={v => setParam('niche', v)} options={[{ key: null, label: 'All' }, ...filters.niches.map(n => ({ key: n.id, label: n.name }))]} />
      <Facet title="Product type" value={params.get('type')} onPick={v => setParam('type', v)} options={[{ key: null, label: 'All' }, ...filters.productTypes.map(t => ({ key: t.id, label: t.name }))]} />
      <div className="mt-auto flex flex-col gap-2 border-t border-[#EDEBE7] pt-[24px]">
        <div className="px-[10px] font-[family-name:var(--font-plex-mono)] text-[10px] uppercase tracking-[0.12em] text-[#78716C]">Setup</div>
        <div className="flex flex-col gap-[1px]">
          {setupLinks.map(s => {
            const active = pathname === s.href
            return (
              <Link key={s.href} href={s.href} className={`flex items-center gap-[10px] rounded-[8px] px-[10px] py-[8px] text-[13px] transition-colors ${active ? 'bg-[#F0EFFB] font-semibold text-[#3F3AC4]' : 'text-[#57534E] hover:bg-[#F2F1EE]'}`}>
                <span className="material-symbols-outlined text-[18px]">{s.icon}</span>{s.label}
              </Link>
            )
          })}
        </div>
      </div>
    </aside>
  )
}
