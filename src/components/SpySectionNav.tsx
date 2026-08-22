'use client'
import Link from 'next/link'

export type SpyNavItem = { key: string; label: string; icon: string; href?: string; onClick?: () => void }

export default function SpySectionNav({ items, active }: { items: SpyNavItem[]; active: string }) {
  return (
    <nav className="mb-lg flex flex-wrap gap-lg border-b border-outline-variant/20">
      {items.map(it => {
        const cls = `flex items-center gap-xs border-b-2 pb-sm text-label-md transition-colors ${
          active === it.key
            ? 'border-primary text-primary font-semibold'
            : 'border-transparent text-on-surface-variant hover:text-primary'
        }`
        const inner = (
          <>
            <span className="material-symbols-outlined text-[18px]">{it.icon}</span>
            {it.label}
          </>
        )
        return it.href
          ? <Link key={it.key} href={it.href} className={cls}>{inner}</Link>
          : <button key={it.key} type="button" onClick={it.onClick} className={cls}>{inner}</button>
      })}
    </nav>
  )
}
