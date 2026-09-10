'use client'
import { createContext, ReactNode, useContext, useEffect, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { canAccess, ROLE_LABELS } from '@/lib/roles'
import type { AuthPayload } from '@/lib/auth'

type UserState = { user: AuthPayload | null; loading: boolean; error: boolean }

const UserContext = createContext<UserState | null>(null)
const PUBLIC_PATHS = ['/login', '/no-access']

export function UserProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const isPublic = PUBLIC_PATHS.some(p => pathname === p || pathname.startsWith(`${p}/`))
  const [state, setState] = useState<UserState>({ user: null, loading: !isPublic, error: false })

  useEffect(() => {
    if (isPublic) return
    let cancelled = false
    fetch('/api/auth/me', { cache: 'no-store' })
      .then(async res => {
        if (cancelled) return
        if (res.status === 401) {
          router.replace(`/login?next=${encodeURIComponent(pathname)}`)
          return
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        setState({ user: await res.json(), loading: false, error: false })
      })
      .catch(() => { if (!cancelled) setState({ user: null, loading: false, error: true }) })
    return () => { cancelled = true }
  }, [pathname, isPublic, router])

  return <UserContext.Provider value={state}>{children}</UserContext.Provider>
}

export function useCurrentUser() {
  const ctx = useContext(UserContext)
  if (!ctx) return { user: null, loading: false, error: false }
  return ctx
}

export function RoleGate({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const { user, loading, error } = useCurrentUser()

  if (loading) return null

  if (error || !user) {
    return (
      <div className="flex min-h-screen bg-surface">
        <main className="m-auto max-w-md rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-xl text-center">
          <span className="material-symbols-outlined text-[48px] text-error">error</span>
          <h2 className="mt-md text-headline-sm text-primary">Không xác thực được phiên</h2>
          <p className="mt-sm text-body-sm text-on-surface-variant">Tải lại trang hoặc đăng nhập lại.</p>
          <a href="/login" className="mt-lg inline-block rounded-lg bg-secondary px-lg py-sm text-label-md text-on-secondary">Đăng nhập</a>
        </main>
      </div>
    )
  }

  if (!canAccess(user.role, pathname, user.permissions)) {
    return (
      <div className="flex min-h-screen bg-surface">
        <main className="m-auto max-w-md rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-xl text-center">
          <span className="material-symbols-outlined text-[48px] text-error">lock</span>
          <h2 className="mt-md text-headline-sm text-primary">No Access</h2>
          <p className="mt-sm text-body-sm text-on-surface-variant">{ROLE_LABELS[user.role]} cannot access this page.</p>
        </main>
      </div>
    )
  }

  return <>{children}</>
}
