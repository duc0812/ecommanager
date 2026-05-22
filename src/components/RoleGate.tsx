'use client'
import { ReactNode, useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { canAccess, FeaturePermission, parsePermissions, ROLE_LABELS, UserRole } from '@/lib/roles'

type CurrentAccess = {
  role: UserRole
  permissions: FeaturePermission[]
  name?: string
}

type AppUser = {
  id: string
  name: string
  email: string
  role: UserRole
  permissions: FeaturePermission[]
  status: string
}

export function getCurrentRole(): UserRole {
  if (typeof window === 'undefined') return 'SUPERADMIN'
  return (localStorage.getItem('currentRole') as UserRole) || 'SUPERADMIN'
}

export function getCurrentAccess(): CurrentAccess {
  if (typeof window === 'undefined') return { role: 'SUPERADMIN', permissions: [] }
  return {
    role: getCurrentRole(),
    permissions: parsePermissions(localStorage.getItem('currentPermissions')),
    name: localStorage.getItem('currentUserName') || undefined,
  }
}

export function RoleGate({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const [access, setAccess] = useState<CurrentAccess>({ role: 'SUPERADMIN', permissions: [] })

  useEffect(() => {
    setAccess(getCurrentAccess())
    const onStorage = () => setAccess(getCurrentAccess())
    window.addEventListener('storage', onStorage)
    window.addEventListener('role-change', onStorage)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('role-change', onStorage)
    }
  }, [])

  if (!canAccess(access.role, pathname, access.permissions)) {
    return (
      <div className="flex min-h-screen bg-surface">
        <main className="m-auto max-w-md rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-xl text-center">
          <span className="material-symbols-outlined text-[48px] text-error">lock</span>
          <h2 className="mt-md text-headline-sm text-primary">No Access</h2>
          <p className="mt-sm text-body-sm text-on-surface-variant">{ROLE_LABELS[access.role]} cannot access this page.</p>
        </main>
      </div>
    )
  }

  return <>{children}</>
}

export function RoleSwitcher() {
  const [users, setUsers] = useState<AppUser[]>([])
  const [selectedUserId, setSelectedUserId] = useState('')
  const [role, setRole] = useState<UserRole>('SUPERADMIN')

  useEffect(() => {
    setRole(getCurrentRole())
    setSelectedUserId(localStorage.getItem('currentUserId') || '')
    fetch('/api/users')
      .then(res => res.json())
      .then((data: AppUser[]) => {
        setUsers(data.filter(user => user.status === 'ACTIVE'))
      })
      .catch(() => setUsers([]))
  }, [])

  function applyAccess(user: AppUser) {
    localStorage.setItem('currentUserId', user.id)
    localStorage.setItem('currentUserName', user.name)
    localStorage.setItem('currentRole', user.role)
    localStorage.setItem('currentPermissions', JSON.stringify(user.permissions))
    setSelectedUserId(user.id)
    setRole(user.role)
    window.dispatchEvent(new Event('role-change'))
  }

  function changeRole(next: UserRole) {
    localStorage.removeItem('currentUserId')
    localStorage.removeItem('currentUserName')
    localStorage.removeItem('currentPermissions')
    localStorage.setItem('currentRole', next)
    setSelectedUserId('')
    setRole(next)
    window.dispatchEvent(new Event('role-change'))
  }

  if (users.length > 0) {
    return (
      <select
        value={selectedUserId}
        onChange={e => {
          const user = users.find(item => item.id === e.target.value)
          if (user) applyAccess(user)
        }}
        className="w-full rounded-lg bg-white/10 px-sm py-xs text-label-sm text-on-primary outline-none"
      >
        <option value="">Select user</option>
        {users.map(user => <option key={user.id} value={user.id}>{user.name} - {ROLE_LABELS[user.role]}</option>)}
      </select>
    )
  }

  return (
    <select value={role} onChange={e => changeRole(e.target.value as UserRole)} className="w-full rounded-lg bg-white/10 px-sm py-xs text-label-sm text-on-primary outline-none">
      {(Object.keys(ROLE_LABELS) as UserRole[]).map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
    </select>
  )
}
