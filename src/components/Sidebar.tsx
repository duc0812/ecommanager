'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { RoleSwitcher, getCurrentAccess } from '@/components/RoleGate'
import { FeaturePermission, UserRole, visibleFor } from '@/lib/roles'

type NavItem = { type: 'item' | 'child'; href: string; icon: string; label: string }
type NavGroup = { type: 'group'; label: string }
type NavDivider = { type: 'divider' }
type NavEntry = NavItem | NavGroup | NavDivider

const nav: NavEntry[] = [
  { type: 'item', href: '/', icon: 'dashboard', label: 'Overview' },
  { type: 'divider' },
  { type: 'group', label: 'Project Management' },
  { type: 'child', href: '/projects', icon: 'analytics', label: 'Dashboard' },
  { type: 'divider' },
  { type: 'group', label: 'Finance' },
  { type: 'child', href: '/shopify', icon: 'payments', label: 'Shopify' },
  { type: 'child', href: '/finance/meta', icon: 'campaign', label: 'Meta Billing' },
  { type: 'child', href: '/finance/other-bills', icon: 'receipt_long', label: 'Other Bills' },
  { type: 'divider' },
  { type: 'group', label: 'Fulfillment' },
  { type: 'child', href: '/fulfillment', icon: 'local_shipping', label: 'Dashboard' },
  { type: 'child', href: '/fulfillment/crawler', icon: 'travel_explore', label: 'Product Crawler' },
  { type: 'child', href: '/fulfillment/orders', icon: 'receipt_long', label: 'Orders & P/L' },
  { type: 'child', href: '/fulfillment/export', icon: 'file_download', label: 'CSV Export' },
  { type: 'child', href: '/fulfillment/suppliers', icon: 'factory', label: 'Suppliers' },
  { type: 'child', href: '/fulfillment/mapping', icon: 'account_tree', label: 'Product Mapping' },
  { type: 'divider' },
  { type: 'group', label: 'Tools' },
  { type: 'child', href: '/tools/spy-idea', icon: 'travel_explore', label: 'Spy Idea' },
  { type: 'child', href: '/tools/resources', icon: 'dns', label: 'Resources' },
  { type: 'divider' },
  { type: 'group', label: 'Setup' },
  { type: 'child', href: '/setup', icon: 'store', label: 'Store' },
  { type: 'child', href: '/setup/meta', icon: 'campaign', label: 'Meta' },
  { type: 'child', href: '/setup/projects', icon: 'folder', label: 'Projects' },
  { type: 'child', href: '/setup/hr', icon: 'group', label: 'HR' },
  { type: 'child', href: '/setup/users', icon: 'admin_panel_settings', label: 'Users' },
]

export default function Sidebar() {
  const pathname = usePathname()
  const [role, setRole] = useState<UserRole>('SUPERADMIN')
  const [permissions, setPermissions] = useState<FeaturePermission[]>([])

  useEffect(() => {
    const update = () => {
      const access = getCurrentAccess()
      setRole(access.role)
      setPermissions(access.permissions)
    }
    update()
    window.addEventListener('role-change', update)
    return () => window.removeEventListener('role-change', update)
  }, [])

  return (
    <aside className="fixed left-0 top-0 h-full w-[280px] bg-primary flex flex-col py-lg z-50 border-r border-white/5">
      <div className="px-lg mb-lg">
        <h1 className="text-headline-sm font-black text-on-primary">Ecom Manager</h1>
        <p className="text-on-primary/60 text-body-sm">Cashflow Suite</p>
      </div>

      <nav className="flex-1 space-y-[2px] px-md overflow-y-auto">
        {nav.map((entry, i) => {
          if (entry.type === 'divider') {
            return <div key={i} className="my-sm border-t border-white/5" />
          }
          if (entry.type === 'group') {
            return (
              <p key={i} className="px-md pt-xs pb-xs text-label-sm font-semibold text-on-primary/30 uppercase tracking-widest">
                {entry.label}
              </p>
            )
          }
          if (!visibleFor(role, entry.href, permissions)) return null
          const isChild = entry.type === 'child'
          const active = pathname === entry.href || (entry.href !== '/' && pathname.startsWith(entry.href))
          return (
            <Link
              key={entry.href}
              href={entry.href}
              className={`flex items-center gap-md rounded-lg transition-all duration-200 ${
                isChild ? 'pl-[28px] pr-md py-[6px]' : 'px-md py-sm'
              } ${
                active
                  ? 'bg-secondary text-on-secondary'
                  : 'text-on-primary/60 hover:text-on-primary hover:bg-white/10'
              }`}
            >
              <span className="material-symbols-outlined text-[18px]">{entry.icon}</span>
              <span className={`${isChild ? 'text-body-sm' : 'text-label-md font-semibold'}`}>{entry.label}</span>
            </Link>
          )
        })}
      </nav>

      <div className="px-md mt-auto">
        <div className="px-md py-sm rounded-lg bg-white/5">
          <p className="mb-xs text-on-primary/40 text-label-sm">Current user</p>
          <RoleSwitcher />
        </div>
      </div>
    </aside>
  )
}
