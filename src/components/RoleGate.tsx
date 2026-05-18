'use client'
import { ReactNode, useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { canAccess, ROLE_LABELS, UserRole } from '@/lib/roles'

export function getCurrentRole(): UserRole {
  if (typeof window === 'undefined') return 'SUPERADMIN'
  return (localStorage.getItem('currentRole') as UserRole) || 'SUPERADMIN'
}

export function RoleGate({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const [role, setRole] = useState<UserRole>('SUPERADMIN')

  useEffect(() => {
    setRole(getCurrentRole())
    const onStorage = () => setRole(getCurrentRole())
    window.addEventListener('storage', onStorage)
    window.addEventListener('role-change', onStorage)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('role-change', onStorage)
    }
  }, [])

  if (!canAccess(role, pathname)) {
    return (
      <div className="flex min-h-screen bg-surface">
        <main className="m-auto max-w-md rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-xl text-center">
          <span className="material-symbols-outlined text-[48px] text-error">lock</span>
          <h2 className="mt-md text-headline-sm text-primary">No Access</h2>
          <p className="mt-sm text-body-sm text-on-surface-variant">{ROLE_LABELS[role]} cannot access this page.</p>
        </main>
      </div>
    )
  }

  return <>{children}</>
}

export function RoleSwitcher() {
  const [role, setRole] = useState<UserRole>('SUPERADMIN')

  useEffect(() => setRole(getCurrentRole()), [])

  function changeRole(next: UserRole) {
    localStorage.setItem('currentRole', next)
    setRole(next)
    window.dispatchEvent(new Event('role-change'))
  }

  return (
    <select value={role} onChange={e => changeRole(e.target.value as UserRole)} className="w-full rounded-lg bg-white/10 px-sm py-xs text-label-sm text-on-primary outline-none">
      {(Object.keys(ROLE_LABELS) as UserRole[]).map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
    </select>
  )
}
