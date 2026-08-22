'use client'
import Link from 'next/link'

export type FiltersData = { domains: string[]; niches: { id: string; name: string }[]; productTypes: { id: string; name: string }[] }
export type Selected = { domain: string | null; niche: string | null; type: string | null }

function Facet({ title, options, value, onPick }: { title: string; options: { key: string | null; label: string }[]; value: string | null; onPick: (v: string | null) => void }) {
  return (
    <div className="mb-md">
      <p className="mb-xs px-xs text-label-sm uppercase tracking-wider text-on-surface-variant">{title}</p>
      {options.map(o => {
        const active = (o.key ?? null) === value
        return (
          <button key={o.key ?? '__all'} onClick={() => onPick(o.key)}
            className={`flex w-full items-center rounded-lg px-md py-xs text-left text-body-sm ${active ? 'bg-secondary-fixed font-semibold text-primary' : 'text-on-surface hover:bg-surface-container-low'}`}>
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

export default function SpyFilterSidebar({ filters, selected, onSelect }: { filters: FiltersData; selected: Selected; onSelect: (dim: 'domain'|'niche'|'type', value: string | null) => void }) {
  return (
    <aside className="w-[220px] flex-none rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-md shadow-card">
      <Facet title="Domain" value={selected.domain} onPick={v => onSelect('domain', v)}
        options={[{ key: null, label: 'All' }, ...filters.domains.map(d => ({ key: d, label: d }))]} />
      <Facet title="Niche" value={selected.niche} onPick={v => onSelect('niche', v)}
        options={[{ key: null, label: 'All' }, ...filters.niches.map(n => ({ key: n.id, label: n.name }))]} />
      <Facet title="Product type" value={selected.type} onPick={v => onSelect('type', v)}
        options={[{ key: null, label: 'All' }, ...filters.productTypes.map(t => ({ key: t.id, label: t.name }))]} />
      <div className="my-md h-px bg-outline-variant/40" />
      <div>
        <p className="mb-xs px-xs text-label-sm uppercase tracking-wider text-on-surface-variant">Setup</p>
        {[
          { href: '/tools/spy-idea/sources', icon: 'storefront', label: 'Sources' },
          { href: '/tools/spy-idea/niches', icon: 'sell', label: 'Niche' },
          { href: '/tools/spy-idea/product-types', icon: 'category', label: 'Product type' },
        ].map(s => (
          <Link key={s.href} href={s.href} className="flex items-center gap-sm rounded-lg px-md py-xs text-body-sm text-secondary hover:bg-surface-container-low">
            <span className="material-symbols-outlined text-[18px]">{s.icon}</span>{s.label}
          </Link>
        ))}
      </div>
    </aside>
  )
}
