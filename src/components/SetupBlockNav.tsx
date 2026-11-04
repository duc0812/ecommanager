'use client'
import Link from 'next/link'
import { useCurrentUser } from '@/components/RoleGate'
import { visibleFor, type UserRole } from '@/lib/roles'
import { SETUP_BLOCKS, type SetupBlock } from '@/lib/setup-blocks'

export function SetupBlockTabs({ block, onPick }: { block: SetupBlock; onPick: (b: SetupBlock) => void }) {
  return (
    <div role="tablist" aria-label="Khối" className="flex items-center gap-xs flex-wrap mb-lg">
      {SETUP_BLOCKS.map(b => {
        const on = b.id === block
        return (
          <button key={b.id} type="button" role="tab" aria-selected={on} onClick={() => onPick(b.id)}
            className={`inline-flex items-center gap-xs h-10 px-md rounded-lg text-body-sm font-semibold ${on ? 'bg-on-surface text-surface' : 'bg-surface-container-lowest border border-outline-variant/40 text-on-surface-variant hover:bg-surface-container-low'}`}>
            <span className="material-symbols-outlined text-[18px]" aria-hidden="true">{b.icon}</span>{b.label}
          </button>
        )
      })}
    </div>
  )
}

/** The block's settings that have a page of their own; a page this user cannot open is not offered. */
export function SetupBlockLinks({ block }: { block: SetupBlock }) {
  const { user } = useCurrentUser()
  const info = SETUP_BLOCKS.find(b => b.id === block)
  const links = (info?.links ?? []).filter(l => {
    if (!user) return false
    if (l.superAdminOnly) return user.role === 'SUPERADMIN'
    return visibleFor(user.role as UserRole, l.href, user.permissions)
  })
  if (links.length === 0) return null
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-md mb-lg">
      {links.map(l => (
        <Link key={l.href} href={l.href}
          className="flex items-center gap-sm bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20 p-md hover:border-secondary/50">
          <span className="material-symbols-outlined text-secondary" aria-hidden="true">{l.icon}</span>
          <span className="min-w-0 flex flex-col">
            <b className="text-body-sm text-on-surface">{l.label}</b>
            <span className="text-label-sm text-on-surface-variant truncate">{l.hint}</span>
          </span>
          <span className="material-symbols-outlined ml-auto text-on-surface-variant text-[18px]" aria-hidden="true">chevron_right</span>
        </Link>
      ))}
    </div>
  )
}
