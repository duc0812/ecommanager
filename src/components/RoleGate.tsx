'use client'
import { ReactNode, useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { canAccess, FeaturePermission, ROLE_LABELS, UserRole } from '@/lib/roles'
import type { AuthPayload } from '@/lib/auth'

type CurrentAccess = {
  role: UserRole
  permissions: FeaturePermission[]
  name: string
}

export function useCurrentUser() {
  const [user, setUser] = useState<AuthPayload | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/auth/me')
      .then(res => res.ok ? res.json() : null)
      .then(data => { setUser(data); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  return { user, loading }
}

export function getCurrentAccess(): CurrentAccess {
  return { role: 'SUPERADMIN', permissions: [], name: '' }
}

export function RoleGate({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const { user, loading } = useCurrentUser()

  if (loading) return null

  const role = user?.role ?? 'SUPERADMIN'
  const permissions = user?.permissions ?? []

  if (!canAccess(role, pathname, permissions)) {
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
