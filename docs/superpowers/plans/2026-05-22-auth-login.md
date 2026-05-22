# Auth & Login System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add email + password login with 7-day JWT cookie session, replacing the current localStorage-based role system.

**Architecture:** JWT signed with `AUTH_SECRET` stored in httpOnly cookie `auth_token`. Next.js middleware verifies the cookie on every request and redirects unauthenticated users to `/login`. Passwords are bcrypt-hashed and stored in `AppUser.passwordHash`. Client reads current user from `GET /api/auth/me` instead of localStorage.

**Tech Stack:** `bcryptjs` for hashing, `jose` (built into Next.js) for JWT, Next.js middleware, Prisma migration

---

## File Map

| Action | File |
|--------|------|
| Modify | `prisma/schema.prisma` — add `passwordHash` field |
| Create | `src/lib/auth.ts` — JWT sign/verify utilities |
| Create | `src/app/api/auth/login/route.ts` — POST login |
| Create | `src/app/api/auth/me/route.ts` — GET current user |
| Create | `src/app/api/auth/logout/route.ts` — POST logout |
| Create | `src/app/api/users/[id]/route.ts` — PATCH set password |
| Create | `src/middleware.ts` — protect all routes |
| Create | `src/app/login/page.tsx` — login form UI |
| Modify | `src/components/RoleGate.tsx` — replace localStorage with /api/auth/me |
| Modify | `src/components/Sidebar.tsx` — replace RoleSwitcher with user info + logout |
| Modify | `src/app/setup/users/page.tsx` — add Set Password button |
| Modify | `.env` + `.env.example` — add `AUTH_SECRET` |

---

## Task 1: Install bcryptjs

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install packages**

```bash
cd "C:/Users/TM PC/Desktop/Ecom manager/ecommanager-claude-ecommerce-cashflow-tool-XsLzh"
npm install bcryptjs
npm install --save-dev @types/bcryptjs
```

Expected output: `added N packages`

- [ ] **Step 2: Commit**

```bash
git add package.json package-lock.json
git commit -m "deps: add bcryptjs"
```

---

## Task 2: Schema Migration — Add passwordHash

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Add field to AppUser model**

In `prisma/schema.prisma`, find the `AppUser` model and add `passwordHash` after `permissions`:

```prisma
model AppUser {
  id           String   @id @default(cuid())
  name         String
  email        String   @unique
  role         String
  permissions  String   @default("[]")
  status       String   @default("ACTIVE")
  passwordHash String?
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
}
```

- [ ] **Step 2: Run migration**

```bash
cd "C:/Users/TM PC/Desktop/Ecom manager/ecommanager-claude-ecommerce-cashflow-tool-XsLzh"
npx prisma migrate dev --name add_user_password_hash
npx prisma generate
```

Expected: Migration created and applied, client regenerated.

- [ ] **Step 3: Bump SCHEMA_VERSION in src/lib/db.ts**

Change `'v21'` → `'v22'`

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/lib/db.ts
git commit -m "feat: add passwordHash to AppUser"
```

---

## Task 3: JWT Auth Utilities

**Files:**
- Create: `src/lib/auth.ts`
- Test: `src/lib/auth.test.ts`

- [ ] **Step 1: Add AUTH_SECRET to .env**

In `.env`, add:
```
AUTH_SECRET=changeme-replace-with-32-char-random-string
```

In `.env.example`, add:
```
AUTH_SECRET=your-32-char-random-secret
```

Generate a real value with: `openssl rand -base64 32`

- [ ] **Step 2: Write failing tests**

Create `src/lib/auth.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from 'vitest'
import { signToken, verifyToken } from './auth'

beforeAll(() => {
  process.env.AUTH_SECRET = 'test-secret-that-is-long-enough-32chars'
})

describe('signToken / verifyToken', () => {
  it('round-trips user payload', async () => {
    const payload = { userId: 'u1', email: 'a@b.com', name: 'A', role: 'ADMIN', permissions: ['overview'] }
    const token = await signToken(payload)
    expect(typeof token).toBe('string')
    const result = await verifyToken(token)
    expect(result?.userId).toBe('u1')
    expect(result?.email).toBe('a@b.com')
    expect(result?.role).toBe('ADMIN')
  })

  it('returns null for invalid token', async () => {
    const result = await verifyToken('not-a-token')
    expect(result).toBeNull()
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd "C:/Users/TM PC/Desktop/Ecom manager/ecommanager-claude-ecommerce-cashflow-tool-XsLzh"
npx vitest run src/lib/auth.test.ts
```

Expected: FAIL — `Cannot find module './auth'`

- [ ] **Step 4: Create src/lib/auth.ts**

```typescript
import { SignJWT, jwtVerify } from 'jose'
import { FeaturePermission, UserRole } from '@/lib/roles'

export type AuthPayload = {
  userId: string
  email: string
  name: string
  role: UserRole
  permissions: FeaturePermission[]
}

function secret() {
  const s = process.env.AUTH_SECRET
  if (!s) throw new Error('AUTH_SECRET is not set')
  return new TextEncoder().encode(s)
}

export async function signToken(payload: AuthPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(secret())
}

export async function verifyToken(token: string): Promise<AuthPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secret())
    return payload as unknown as AuthPayload
  } catch {
    return null
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run src/lib/auth.test.ts
```

Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add src/lib/auth.ts src/lib/auth.test.ts .env.example
git commit -m "feat: JWT sign/verify utilities"
```

---

## Task 4: Auth API Routes

**Files:**
- Create: `src/app/api/auth/login/route.ts`
- Create: `src/app/api/auth/me/route.ts`
- Create: `src/app/api/auth/logout/route.ts`

- [ ] **Step 1: Create POST /api/auth/login**

Create `src/app/api/auth/login/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/db'
import { signToken } from '@/lib/auth'
import { parsePermissions, UserRole } from '@/lib/roles'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const { email, password } = await req.json()
  if (!email || !password) {
    return NextResponse.json({ error: 'Email hoặc password không đúng' }, { status: 401 })
  }

  const user = await prisma.appUser.findUnique({ where: { email: String(email).toLowerCase() } })
  if (!user || user.status !== 'ACTIVE' || !user.passwordHash) {
    return NextResponse.json({ error: 'Email hoặc password không đúng' }, { status: 401 })
  }

  const valid = await bcrypt.compare(String(password), user.passwordHash)
  if (!valid) {
    return NextResponse.json({ error: 'Email hoặc password không đúng' }, { status: 401 })
  }

  const token = await signToken({
    userId: user.id,
    email: user.email,
    name: user.name,
    role: user.role as UserRole,
    permissions: parsePermissions(user.permissions),
  })

  const res = NextResponse.json({ ok: true })
  res.cookies.set('auth_token', token, {
    httpOnly: true,
    sameSite: 'strict',
    maxAge: 60 * 60 * 24 * 7,
    path: '/',
  })
  return res
}
```

- [ ] **Step 2: Create GET /api/auth/me**

Create `src/app/api/auth/me/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const token = req.cookies.get('auth_token')?.value
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const payload = await verifyToken(token)
  if (!payload) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return NextResponse.json(payload)
}
```

- [ ] **Step 3: Create POST /api/auth/logout**

Create `src/app/api/auth/logout/route.ts`:

```typescript
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function POST() {
  const res = NextResponse.json({ ok: true })
  res.cookies.set('auth_token', '', { maxAge: 0, path: '/' })
  return res
}
```

- [ ] **Step 4: Commit**

```bash
git add src/app/api/auth
git commit -m "feat: auth API routes (login, me, logout)"
```

---

## Task 5: PATCH /api/users/[id] — Set Password

**Files:**
- Create: `src/app/api/users/[id]/route.ts`

- [ ] **Step 1: Create route file**

Create `src/app/api/users/[id]/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/db'

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const { password } = await req.json()
  if (!password || String(password).length < 6) {
    return NextResponse.json({ error: 'Password phải có ít nhất 6 ký tự' }, { status: 400 })
  }
  const passwordHash = await bcrypt.hash(String(password), 10)
  await prisma.appUser.update({ where: { id: params.id }, data: { passwordHash } })
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/users/[id]/route.ts
git commit -m "feat: PATCH /api/users/[id] to set password"
```

---

## Task 6: Middleware — Protect All Routes

**Files:**
- Create: `src/middleware.ts`

- [ ] **Step 1: Create middleware**

Create `src/middleware.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/auth'

const PUBLIC_PATHS = ['/login', '/api/auth/login']

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl

  if (PUBLIC_PATHS.some(p => pathname.startsWith(p))) {
    return NextResponse.next()
  }

  const token = req.cookies.get('auth_token')?.value
  if (!token) {
    return NextResponse.redirect(new URL('/login', req.url))
  }

  const payload = await verifyToken(token)
  if (!payload) {
    return NextResponse.redirect(new URL('/login', req.url))
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
```

- [ ] **Step 2: Commit**

```bash
git add src/middleware.ts
git commit -m "feat: middleware to protect all routes"
```

---

## Task 7: Login Page UI

**Files:**
- Create: `src/app/login/page.tsx`

- [ ] **Step 1: Create login page**

Create `src/app/login/page.tsx`:

```typescript
'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    if (res.ok) {
      router.push('/')
      router.refresh()
    } else {
      const data = await res.json()
      setError(data.error || 'Email hoặc password không đúng')
    }
    setLoading(false)
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface">
      <div className="w-full max-w-sm rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-xl shadow-card">
        <h1 className="text-headline-md font-bold text-primary mb-xs">Ecom Manager</h1>
        <p className="text-body-sm text-on-surface-variant mb-xl">Đăng nhập để tiếp tục</p>

        <form onSubmit={handleSubmit} className="space-y-md">
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            className="w-full rounded-lg border border-outline-variant/30 bg-surface-container px-md py-sm outline-none focus:border-secondary"
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            className="w-full rounded-lg border border-outline-variant/30 bg-surface-container px-md py-sm outline-none focus:border-secondary"
          />
          {error && <p className="text-label-sm text-error">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-secondary py-md text-label-md font-semibold text-on-secondary disabled:opacity-50"
          >
            {loading ? 'Đang đăng nhập...' : 'Đăng nhập'}
          </button>
        </form>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/login/page.tsx
git commit -m "feat: login page UI"
```

---

## Task 8: Update RoleGate — Replace localStorage with /api/auth/me

**Files:**
- Modify: `src/components/RoleGate.tsx`

- [ ] **Step 1: Rewrite RoleGate.tsx**

Replace the entire content of `src/components/RoleGate.tsx`:

```typescript
'use client'
import { ReactNode, useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { canAccess, FeaturePermission, ROLE_LABELS, UserRole } from '@/lib/roles'
import { AuthPayload } from '@/lib/auth'

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
```

- [ ] **Step 2: Commit**

```bash
git add src/components/RoleGate.tsx
git commit -m "feat: RoleGate reads from /api/auth/me instead of localStorage"
```

---

## Task 9: Update Sidebar — User Info + Logout

**Files:**
- Modify: `src/components/Sidebar.tsx`

- [ ] **Step 1: Replace bottom section of Sidebar**

In `src/components/Sidebar.tsx`:

1. Remove the import of `RoleSwitcher, getCurrentAccess` from `@/components/RoleGate`
2. Add import of `useCurrentUser` from `@/components/RoleGate`
3. Update the component to use `useCurrentUser` hook
4. Replace the bottom `<div>` (the "Current user" block with `<RoleSwitcher />`) with user info + logout button

Replace the entire file content with:

```typescript
'use client'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { useCurrentUser } from '@/components/RoleGate'
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
  const router = useRouter()
  const { user } = useCurrentUser()
  const role: UserRole = user?.role ?? 'SUPERADMIN'
  const permissions: FeaturePermission[] = user?.permissions ?? []

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' })
    router.push('/login')
    router.refresh()
  }

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
          <p className="text-on-primary/40 text-label-sm truncate">{user?.name ?? '...'}</p>
          <p className="text-on-primary/25 text-label-sm truncate mb-xs">{user?.email ?? ''}</p>
          <button
            onClick={logout}
            className="flex items-center gap-xs text-on-primary/60 hover:text-error text-label-sm transition-colors"
          >
            <span className="material-symbols-outlined text-[16px]">logout</span>
            Đăng xuất
          </button>
        </div>
      </div>
    </aside>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/Sidebar.tsx
git commit -m "feat: sidebar shows current user and logout button"
```

---

## Task 10: Setup > Users — Add Set Password Button

**Files:**
- Modify: `src/app/setup/users/page.tsx`

- [ ] **Step 1: Add password modal state and handler**

In `src/app/setup/users/page.tsx`, add the following state variables and handler after the existing `const [saving, setSaving] = useState(false)` line:

```typescript
const [passwordUserId, setPasswordUserId] = useState<string | null>(null)
const [newPassword, setNewPassword] = useState('')
const [passwordSaving, setPasswordSaving] = useState(false)
const [passwordError, setPasswordError] = useState('')

async function savePassword() {
  if (!passwordUserId || newPassword.length < 6) {
    setPasswordError('Password phải có ít nhất 6 ký tự')
    return
  }
  setPasswordSaving(true)
  setPasswordError('')
  const res = await fetch(`/api/users/${passwordUserId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: newPassword }),
  })
  if (res.ok) {
    setPasswordUserId(null)
    setNewPassword('')
  } else {
    const data = await res.json()
    setPasswordError(data.error || 'Lỗi khi lưu password')
  }
  setPasswordSaving(false)
}
```

- [ ] **Step 2: Add "Set Password" button to each user row**

In the user row actions `<div>` (the one with Edit and Delete buttons), add a "Set Password" button for all users:

```typescript
<td className="px-lg py-md text-right">
  <div className="flex justify-end gap-sm">
    <button onClick={() => { setPasswordUserId(user.id); setNewPassword(''); setPasswordError('') }} className="text-on-surface-variant text-label-sm hover:underline">Set Password</button>
    {user.role !== 'SUPERADMIN' && (
      <>
        <button onClick={() => editUser(user)} className="text-secondary text-label-sm hover:underline">Edit</button>
        <button onClick={() => deleteUser(user.id)} className="text-error text-label-sm hover:underline">Delete</button>
      </>
    )}
  </div>
</td>
```

- [ ] **Step 3: Add password modal**

Before the closing `</RoleGate>` tag, add the modal:

```typescript
{passwordUserId && (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
    <div className="w-full max-w-sm rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-xl shadow-card">
      <h3 className="text-headline-sm text-primary mb-md">Set Password</h3>
      <div className="space-y-md">
        <input
          type="password"
          placeholder="Password mới (tối thiểu 6 ký tự)"
          value={newPassword}
          onChange={e => setNewPassword(e.target.value)}
          className="w-full rounded-lg border border-outline-variant/30 bg-surface-container px-md py-sm outline-none"
        />
        {passwordError && <p className="text-label-sm text-error">{passwordError}</p>}
        <div className="flex gap-sm">
          <button onClick={savePassword} disabled={passwordSaving} className="flex-1 rounded-lg bg-secondary py-md text-label-md font-semibold text-on-secondary disabled:opacity-50">
            {passwordSaving ? 'Đang lưu...' : 'Lưu'}
          </button>
          <button onClick={() => setPasswordUserId(null)} className="rounded-lg border border-outline-variant/30 px-md py-md text-label-md text-on-surface-variant">
            Hủy
          </button>
        </div>
      </div>
    </div>
  </div>
)}
```

- [ ] **Step 4: Commit**

```bash
git add src/app/setup/users/page.tsx
git commit -m "feat: set password button in users page"
```

---

## Task 11: Build, Push, Deploy

- [ ] **Step 1: Build locally to verify no errors**

```bash
cd "C:/Users/TM PC/Desktop/Ecom manager/ecommanager-claude-ecommerce-cashflow-tool-XsLzh"
npm run build
```

Expected: Build completes with no errors.

- [ ] **Step 2: Push to GitHub**

```bash
git push origin main
```

- [ ] **Step 3: Set AUTH_SECRET on VPS**

SSH into VPS and add `AUTH_SECRET` to `.env`:

```bash
echo "AUTH_SECRET=$(openssl rand -base64 32)" >> /home/podmanager/.env
```

- [ ] **Step 4: Deploy on VPS**

```bash
/home/podmanager/deploy.sh
```

- [ ] **Step 5: Set SUPERADMIN password**

After deploy, go to `http://178.105.170.0:3002/setup/users`.

**Important:** The middleware will redirect to `/login` but SUPERADMIN has no password yet. To bootstrap:
1. Temporarily comment out the middleware redirect in `src/middleware.ts` (or add `/setup/users` to PUBLIC_PATHS), push, deploy
2. Set SUPERADMIN password via the UI
3. Re-enable middleware, push, deploy again

**OR** set password directly via Node.js on VPS:

```bash
cd /home/podmanager
node -e "
const bcrypt = require('bcryptjs');
const { PrismaLibSql } = require('@prisma/adapter-libsql');
const { PrismaClient } = require('./src/generated/prisma/client');
const path = require('path');
const adapter = new PrismaLibSql({ url: 'file:' + path.resolve(process.cwd(), 'dev.db') });
const prisma = new PrismaClient({ adapter });
bcrypt.hash('changeme123', 10).then(hash => {
  return prisma.appUser.updateMany({ where: { role: 'SUPERADMIN' }, data: { passwordHash: hash } });
}).then(() => { console.log('Password set!'); process.exit(0); });
"
```

Then login at `http://178.105.170.0:3002/login` with `superadmin@local` / `changeme123` and change the password immediately via Setup > Users.
