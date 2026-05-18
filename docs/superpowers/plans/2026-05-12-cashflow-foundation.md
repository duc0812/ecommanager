# Ecommerce Cashflow Manager — Plan 1: Foundation & Core

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a multi-user cashflow management tool for ecommerce projects with manual transaction entry, card tracking, label filtering, and a real-time cashflow dashboard.

**Architecture:** Next.js 14 App Router with PostgreSQL via Prisma ORM. Auth via NextAuth v4 with credentials provider. All data scoped to projects with role-based access (ADMIN/OWNER/EDITOR/VIEWER).

**Tech Stack:** Next.js 14, TypeScript, PostgreSQL, Prisma 5, NextAuth v4, shadcn/ui, Tailwind CSS 3, Recharts 2, TanStack Query v5, Zod v3, bcryptjs, crypto (built-in AES-256)

**Branch:** `claude/ecommerce-cashflow-tool-XsLzh`

---

## File Map

```
ecommanager/
├── prisma/
│   ├── schema.prisma
│   └── seed.ts
├── src/
│   ├── app/
│   │   ├── (auth)/
│   │   │   ├── login/page.tsx
│   │   │   └── register/page.tsx
│   │   ├── (dashboard)/
│   │   │   ├── layout.tsx
│   │   │   ├── page.tsx                        ← global overview
│   │   │   ├── projects/
│   │   │   │   ├── page.tsx
│   │   │   │   ├── new/page.tsx
│   │   │   │   └── [id]/
│   │   │   │       ├── page.tsx                ← project cashflow dashboard
│   │   │   │       ├── transactions/
│   │   │   │       │   ├── page.tsx
│   │   │   │       │   └── new/page.tsx
│   │   │   │       ├── labels/page.tsx
│   │   │   │       └── settings/page.tsx
│   │   │   └── cards/
│   │   │       ├── page.tsx
│   │   │       └── new/page.tsx
│   │   ├── api/
│   │   │   ├── auth/[...nextauth]/route.ts
│   │   │   ├── projects/
│   │   │   │   ├── route.ts
│   │   │   │   └── [id]/
│   │   │   │       ├── route.ts
│   │   │   │       ├── cashflow/route.ts
│   │   │   │       ├── transactions/route.ts
│   │   │   │       ├── members/route.ts
│   │   │   │       └── labels/route.ts
│   │   │   ├── cards/
│   │   │   │   ├── route.ts
│   │   │   │   └── [id]/route.ts
│   │   │   ├── transactions/[id]/route.ts
│   │   │   └── upload/route.ts
│   │   ├── layout.tsx
│   │   └── globals.css
│   ├── components/
│   │   ├── layout/
│   │   │   ├── sidebar.tsx
│   │   │   └── top-bar.tsx
│   │   ├── projects/
│   │   │   ├── project-card.tsx
│   │   │   └── project-form.tsx
│   │   ├── transactions/
│   │   │   ├── transaction-table.tsx
│   │   │   ├── transaction-form.tsx
│   │   │   └── transaction-filters.tsx
│   │   ├── cashflow/
│   │   │   ├── cashflow-summary.tsx
│   │   │   ├── cashflow-chart.tsx
│   │   │   └── category-breakdown.tsx
│   │   └── cards/
│   │       └── card-form.tsx
│   ├── lib/
│   │   ├── prisma.ts
│   │   ├── auth.ts
│   │   ├── cashflow.ts
│   │   └── encryption.ts
│   ├── types/
│   │   └── index.ts
│   └── middleware.ts
├── __tests__/
│   ├── lib/cashflow.test.ts
│   └── api/projects.test.ts
├── .env.example
├── jest.config.ts
├── jest.setup.ts
├── next.config.ts
└── package.json
```

---

## Task 1: Project Bootstrap

**Files:**
- Create: `package.json`, `next.config.ts`, `tsconfig.json`, `.env.example`, `jest.config.ts`, `jest.setup.ts`

- [ ] **Step 1: Scaffold Next.js app**

```bash
cd /home/user/ecommanager
npx create-next-app@14 . --typescript --tailwind --eslint --app --src-dir --import-alias "@/*" --no-git
```

- [ ] **Step 2: Install dependencies**

```bash
npm install @prisma/client next-auth@4 bcryptjs zod @tanstack/react-query recharts
npm install -D prisma @types/bcryptjs jest @types/jest ts-jest jest-environment-node @testing-library/react @testing-library/jest-dom
npx shadcn@latest init -y
npx shadcn@latest add button input label card table badge select dialog form toast dropdown-menu separator avatar
```

- [ ] **Step 3: Create `.env.example`**

```env
DATABASE_URL="postgresql://user:password@localhost:5432/ecommanager"
NEXTAUTH_SECRET="change-me-in-production"
NEXTAUTH_URL="http://localhost:3000"
ENCRYPTION_KEY="32-char-secret-key-change-in-prod"
```

- [ ] **Step 4: Create `jest.config.ts`**

```typescript
import type { Config } from 'jest'

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1' },
  setupFilesAfterFramework: ['<rootDir>/jest.setup.ts'],
  testPathPattern: '__tests__',
}

export default config
```

- [ ] **Step 5: Create `jest.setup.ts`**

```typescript
import '@testing-library/jest-dom'
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: scaffold Next.js 14 project with dependencies"
```

---

## Task 2: Database Schema

**Files:**
- Create: `prisma/schema.prisma`, `prisma/seed.ts`

- [ ] **Step 1: Write failing test for schema enums**

Create `__tests__/lib/cashflow.test.ts`:

```typescript
import { Category, TransactionType } from '@prisma/client'

describe('Prisma enums', () => {
  it('Category has all required values', () => {
    expect(Category.SHOPIFY_PAYOUT).toBe('SHOPIFY_PAYOUT')
    expect(Category.PAYPAL).toBe('PAYPAL')
    expect(Category.STRIPE).toBe('STRIPE')
    expect(Category.FB_ADS).toBe('FB_ADS')
    expect(Category.FULFILLMENT).toBe('FULFILLMENT')
    expect(Category.BUSINESS_OPS).toBe('BUSINESS_OPS')
  })

  it('TransactionType has INCOME and EXPENSE', () => {
    expect(TransactionType.INCOME).toBe('INCOME')
    expect(TransactionType.EXPENSE).toBe('EXPENSE')
  })
})
```

- [ ] **Step 2: Run test — expect FAIL (Prisma client not generated yet)**

```bash
npx jest __tests__/lib/cashflow.test.ts
```

Expected: FAIL — `Cannot find module '@prisma/client'`

- [ ] **Step 3: Write `prisma/schema.prisma`**

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum SystemRole { ADMIN MEMBER }
enum ProjectRole { OWNER EDITOR VIEWER }
enum ProjectStatus { ACTIVE ARCHIVED }
enum TransactionType { INCOME EXPENSE }
enum Category { SHOPIFY_PAYOUT PAYPAL STRIPE FB_ADS FULFILLMENT BUSINESS_OPS }
enum DataSource { MANUAL API }
enum Platform { SHOPIFY PAYPAL STRIPE FACEBOOK }
enum SyncStatus { PENDING SYNCING SUCCESS ERROR }

model User {
  id           String          @id @default(cuid())
  email        String          @unique
  name         String?
  passwordHash String
  role         SystemRole      @default(MEMBER)
  createdAt    DateTime        @default(now())
  updatedAt    DateTime        @updatedAt
  memberships  ProjectMember[]
  transactions Transaction[]
  sessions     Session[]
  accounts     Account[]
}

model Project {
  id           String          @id @default(cuid())
  name         String
  description  String?
  startDate    DateTime
  status       ProjectStatus   @default(ACTIVE)
  createdAt    DateTime        @default(now())
  updatedAt    DateTime        @updatedAt
  members      ProjectMember[]
  transactions Transaction[]
  labels       Label[]
  integrations Integration[]
}

model ProjectMember {
  id        String      @id @default(cuid())
  projectId String
  userId    String
  role      ProjectRole @default(VIEWER)
  createdAt DateTime    @default(now())
  project   Project     @relation(fields: [projectId], references: [id], onDelete: Cascade)
  user      User        @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@unique([projectId, userId])
}

model Card {
  id           String        @id @default(cuid())
  name         String
  last4        String?
  bankName     String?
  color        String        @default("#6366f1")
  creditLimit  Float?
  createdAt    DateTime      @default(now())
  updatedAt    DateTime      @updatedAt
  transactions Transaction[]
}

model Label {
  id           String             @id @default(cuid())
  name         String
  color        String             @default("#6366f1")
  projectId    String
  createdAt    DateTime           @default(now())
  project      Project            @relation(fields: [projectId], references: [id], onDelete: Cascade)
  transactions TransactionLabel[]
  @@unique([projectId, name])
}

model Transaction {
  id            String             @id @default(cuid())
  externalId    String?            @unique
  type          TransactionType
  category      Category
  amount        Float
  currency      String             @default("USD")
  date          DateTime
  description   String?
  attachmentUrl String?
  source        DataSource         @default(MANUAL)
  metadata      Json?
  projectId     String
  cardId        String?
  createdById   String
  createdAt     DateTime           @default(now())
  updatedAt     DateTime           @updatedAt
  project       Project            @relation(fields: [projectId], references: [id], onDelete: Cascade)
  card          Card?              @relation(fields: [cardId], references: [id])
  createdBy     User               @relation(fields: [createdById], references: [id])
  labels        TransactionLabel[]
}

model TransactionLabel {
  transactionId String
  labelId       String
  transaction   Transaction @relation(fields: [transactionId], references: [id], onDelete: Cascade)
  label         Label       @relation(fields: [labelId], references: [id], onDelete: Cascade)
  @@id([transactionId, labelId])
}

model Integration {
  id          String      @id @default(cuid())
  platform    Platform
  credentials String
  config      Json?
  status      SyncStatus  @default(PENDING)
  lastSyncAt  DateTime?
  projectId   String
  createdAt   DateTime    @default(now())
  updatedAt   DateTime    @updatedAt
  project     Project     @relation(fields: [projectId], references: [id], onDelete: Cascade)
  syncLogs    SyncLog[]
  @@unique([projectId, platform])
}

model SyncLog {
  id            String      @id @default(cuid())
  integrationId String
  status        SyncStatus
  recordCount   Int         @default(0)
  errors        String?
  syncedAt      DateTime    @default(now())
  integration   Integration @relation(fields: [integrationId], references: [id], onDelete: Cascade)
}

model Account {
  id                String  @id @default(cuid())
  userId            String
  type              String
  provider          String
  providerAccountId String
  refresh_token     String? @db.Text
  access_token      String? @db.Text
  expires_at        Int?
  token_type        String?
  scope             String?
  id_token          String? @db.Text
  session_state     String?
  user              User    @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@unique([provider, providerAccountId])
}

model Session {
  id           String   @id @default(cuid())
  sessionToken String   @unique
  userId       String
  expires      DateTime
  user         User     @relation(fields: [userId], references: [id], onDelete: Cascade)
}

model VerificationToken {
  identifier String
  token      String   @unique
  expires    DateTime
  @@unique([identifier, token])
}
```

- [ ] **Step 4: Generate client and run migration**

```bash
npx prisma generate
npx prisma migrate dev --name init
```

Expected: Migration applied, `prisma/migrations/` folder created.

- [ ] **Step 5: Run test — expect PASS**

```bash
npx jest __tests__/lib/cashflow.test.ts
```

Expected: PASS

- [ ] **Step 6: Write seed file `prisma/seed.ts`**

```typescript
import { PrismaClient, SystemRole, ProjectRole, ProjectStatus } from '@prisma/client'
import bcrypt from 'bcryptjs'

const prisma = new PrismaClient()

async function main() {
  const adminHash = await bcrypt.hash('admin123', 12)
  const admin = await prisma.user.upsert({
    where: { email: 'admin@ecom.local' },
    update: {},
    create: { email: 'admin@ecom.local', name: 'Admin', passwordHash: adminHash, role: SystemRole.ADMIN },
  })

  const project = await prisma.project.upsert({
    where: { id: 'seed-project-1' },
    update: {},
    create: {
      id: 'seed-project-1',
      name: 'Demo Store',
      startDate: new Date('2026-01-01'),
      status: ProjectStatus.ACTIVE,
      members: { create: { userId: admin.id, role: ProjectRole.OWNER } },
    },
  })

  console.log('Seeded:', { admin: admin.email, project: project.name })
}

main().catch(console.error).finally(() => prisma.$disconnect())
```

Add to `package.json`:
```json
"prisma": { "seed": "ts-node --compiler-options '{\"module\":\"CommonJS\"}' prisma/seed.ts" }
```

- [ ] **Step 7: Run seed**

```bash
npx prisma db seed
```

Expected: `Seeded: { admin: 'admin@ecom.local', project: 'Demo Store' }`

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: add Prisma schema with all models and seed data"
```

---

## Task 3: Core Utilities

**Files:**
- Create: `src/lib/prisma.ts`, `src/lib/encryption.ts`, `src/types/index.ts`

- [ ] **Step 1: Write failing test for encryption**

Add to `__tests__/lib/cashflow.test.ts`:

```typescript
import { encrypt, decrypt } from '@/lib/encryption'

describe('encryption', () => {
  it('round-trips a JSON payload', () => {
    const payload = JSON.stringify({ accessToken: 'tok_123', shopDomain: 'my-store.myshopify.com' })
    const cipher = encrypt(payload)
    expect(cipher).not.toBe(payload)
    expect(decrypt(cipher)).toBe(payload)
  })
})
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
npx jest __tests__/lib/cashflow.test.ts -t "encryption"
```

Expected: FAIL — `Cannot find module '@/lib/encryption'`

- [ ] **Step 3: Create `src/lib/encryption.ts`**

```typescript
import crypto from 'crypto'

const KEY = Buffer.from(process.env.ENCRYPTION_KEY!.padEnd(32).slice(0, 32))
const IV_LENGTH = 16

export function encrypt(text: string): string {
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv('aes-256-cbc', KEY, iv)
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  return `${iv.toString('hex')}:${encrypted.toString('hex')}`
}

export function decrypt(text: string): string {
  const [ivHex, encryptedHex] = text.split(':')
  const iv = Buffer.from(ivHex, 'hex')
  const encrypted = Buffer.from(encryptedHex, 'hex')
  const decipher = crypto.createDecipheriv('aes-256-cbc', KEY, iv)
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
}
```

- [ ] **Step 4: Run test — expect PASS**

```bash
ENCRYPTION_KEY="test-key-32-chars-pad-to-32-char" npx jest __tests__/lib/cashflow.test.ts -t "encryption"
```

Expected: PASS

- [ ] **Step 5: Create `src/lib/prisma.ts`**

```typescript
import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient }

export const prisma = globalForPrisma.prisma ?? new PrismaClient()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma
```

- [ ] **Step 6: Create `src/types/index.ts`**

```typescript
import type { Project, Transaction, Card, Label, User, ProjectMember } from '@prisma/client'

export type ProjectWithMembers = Project & {
  members: (ProjectMember & { user: Pick<User, 'id' | 'email' | 'name'> })[]
}

export type TransactionWithRelations = Transaction & {
  card: Card | null
  labels: { label: Label }[]
  createdBy: Pick<User, 'id' | 'email' | 'name'>
}

export type CashflowSummary = {
  totalIncome: number
  totalExpense: number
  net: number
  byCategory: Record<string, number>
  byCard: Record<string, { name: string; total: number }>
  byMonth: { month: string; income: number; expense: number }[]
}
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add prisma singleton, encryption utils, and shared types"
```

---

## Task 4: Authentication

**Files:**
- Create: `src/lib/auth.ts`, `src/app/api/auth/[...nextauth]/route.ts`, `src/middleware.ts`
- Create: `src/app/(auth)/login/page.tsx`, `src/app/(auth)/register/page.tsx`

- [ ] **Step 1: Create `src/lib/auth.ts`**

```typescript
import { NextAuthOptions, getServerSession } from 'next-auth'
import CredentialsProvider from 'next-auth/providers/credentials'
import { PrismaAdapter } from '@next-auth/prisma-adapter'
import bcrypt from 'bcryptjs'
import { prisma } from './prisma'

export const authOptions: NextAuthOptions = {
  adapter: PrismaAdapter(prisma),
  session: { strategy: 'jwt' },
  pages: { signIn: '/login' },
  providers: [
    CredentialsProvider({
      name: 'credentials',
      credentials: { email: { type: 'email' }, password: { type: 'password' } },
      async authorize(credentials) {
        if (!credentials?.email || !credentials.password) return null
        const user = await prisma.user.findUnique({ where: { email: credentials.email } })
        if (!user) return null
        const valid = await bcrypt.compare(credentials.password, user.passwordHash)
        if (!valid) return null
        return { id: user.id, email: user.email, name: user.name, role: user.role }
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) { token.id = user.id; token.role = (user as any).role }
      return token
    },
    async session({ session, token }) {
      if (session.user) { (session.user as any).id = token.id; (session.user as any).role = token.role }
      return session
    },
  },
}

export const getSession = () => getServerSession(authOptions)
```

- [ ] **Step 2: Install NextAuth adapter**

```bash
npm install @next-auth/prisma-adapter
```

- [ ] **Step 3: Create `src/app/api/auth/[...nextauth]/route.ts`**

```typescript
import NextAuth from 'next-auth'
import { authOptions } from '@/lib/auth'

const handler = NextAuth(authOptions)
export { handler as GET, handler as POST }
```

- [ ] **Step 4: Create `src/middleware.ts`**

```typescript
export { default } from 'next-auth/middleware'

export const config = {
  matcher: ['/((?!api/auth|login|register|_next/static|_next/image|favicon.ico).*)'],
}
```

- [ ] **Step 5: Create `src/app/(auth)/login/page.tsx`**

```tsx
'use client'
import { useState } from 'react'
import { signIn } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

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
    const res = await signIn('credentials', { email, password, redirect: false })
    setLoading(false)
    if (res?.error) { setError('Email hoặc mật khẩu không đúng') } 
    else { router.push('/') }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-2xl">Đăng nhập</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" value={email} onChange={e => setEmail(e.target.value)} required />
            </div>
            <div>
              <Label htmlFor="password">Mật khẩu</Label>
              <Input id="password" type="password" value={password} onChange={e => setPassword(e.target.value)} required />
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? 'Đang đăng nhập...' : 'Đăng nhập'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
```

- [ ] **Step 6: Create `src/app/(auth)/register/page.tsx`**

```tsx
'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export default function RegisterPage() {
  const router = useRouter()
  const [form, setForm] = useState({ email: '', name: '', password: '' })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    })
    setLoading(false)
    if (!res.ok) { const d = await res.json(); setError(d.error) }
    else { router.push('/login') }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <Card className="w-full max-w-md">
        <CardHeader><CardTitle className="text-2xl">Tạo tài khoản</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <Label>Tên</Label>
              <Input value={form.name} onChange={e => setForm(f => ({...f, name: e.target.value}))} required />
            </div>
            <div>
              <Label>Email</Label>
              <Input type="email" value={form.email} onChange={e => setForm(f => ({...f, email: e.target.value}))} required />
            </div>
            <div>
              <Label>Mật khẩu</Label>
              <Input type="password" value={form.password} onChange={e => setForm(f => ({...f, password: e.target.value}))} required minLength={8} />
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? 'Đang tạo...' : 'Tạo tài khoản'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
```

- [ ] **Step 7: Create register API `src/app/api/auth/register/route.ts`**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'

const schema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  password: z.string().min(8),
})

export async function POST(req: NextRequest) {
  const body = await req.json()
  const parsed = schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Dữ liệu không hợp lệ' }, { status: 400 })

  const { email, name, password } = parsed.data
  const exists = await prisma.user.findUnique({ where: { email } })
  if (exists) return NextResponse.json({ error: 'Email đã tồn tại' }, { status: 409 })

  const passwordHash = await bcrypt.hash(password, 12)
  await prisma.user.create({ data: { email, name, passwordHash } })
  return NextResponse.json({ ok: true }, { status: 201 })
}
```

- [ ] **Step 8: Add NextAuth SessionProvider to `src/app/layout.tsx`**

```tsx
import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'
import { Providers } from './providers'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = { title: 'Ecom Cashflow Manager' }

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi">
      <body className={inter.className}>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
```

Create `src/app/providers.tsx`:

```tsx
'use client'
import { SessionProvider } from 'next-auth/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient())
  return (
    <SessionProvider>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </SessionProvider>
  )
}
```

- [ ] **Step 9: Start dev server and verify login works**

```bash
npm run dev
```

Open http://localhost:3000/login. Login with `admin@ecom.local` / `admin123`. Should redirect to `/`.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: add NextAuth credentials login, register, JWT session, middleware"
```

---

## Task 5: Cashflow Engine

**Files:**
- Create: `src/lib/cashflow.ts`
- Modify: `__tests__/lib/cashflow.test.ts`

- [ ] **Step 1: Write failing tests for cashflow calculation**

Add to `__tests__/lib/cashflow.test.ts`:

```typescript
import { calculateCashflow } from '@/lib/cashflow'
import { TransactionType, Category } from '@prisma/client'

const makeTransaction = (type: TransactionType, category: Category, amount: number, cardId?: string) => ({
  id: Math.random().toString(),
  externalId: null,
  type,
  category,
  amount,
  currency: 'USD',
  date: new Date(),
  description: null,
  attachmentUrl: null,
  source: 'MANUAL' as const,
  metadata: null,
  projectId: 'p1',
  cardId: cardId ?? null,
  createdById: 'u1',
  createdAt: new Date(),
  updatedAt: new Date(),
  card: cardId ? { id: cardId, name: 'Visa *1234', last4: '1234', bankName: 'ACB', color: '#6366f1', creditLimit: null, createdAt: new Date(), updatedAt: new Date() } : null,
  labels: [],
  createdBy: { id: 'u1', email: 'a@b.com', name: 'Admin' },
})

describe('calculateCashflow', () => {
  it('sums income sources correctly', () => {
    const txns = [
      makeTransaction('INCOME', 'SHOPIFY_PAYOUT', 1000),
      makeTransaction('INCOME', 'PAYPAL', 500),
      makeTransaction('INCOME', 'STRIPE', 300),
    ]
    const result = calculateCashflow(txns as any)
    expect(result.totalIncome).toBe(1800)
    expect(result.totalExpense).toBe(0)
    expect(result.net).toBe(1800)
  })

  it('subtracts expense categories correctly', () => {
    const txns = [
      makeTransaction('INCOME', 'SHOPIFY_PAYOUT', 2000),
      makeTransaction('EXPENSE', 'FB_ADS', 400),
      makeTransaction('EXPENSE', 'FULFILLMENT', 300),
      makeTransaction('EXPENSE', 'BUSINESS_OPS', 100),
    ]
    const result = calculateCashflow(txns as any)
    expect(result.totalIncome).toBe(2000)
    expect(result.totalExpense).toBe(800)
    expect(result.net).toBe(1200)
  })

  it('groups spending by card', () => {
    const txns = [
      makeTransaction('EXPENSE', 'FB_ADS', 200, 'card-1'),
      makeTransaction('EXPENSE', 'FULFILLMENT', 100, 'card-1'),
      makeTransaction('EXPENSE', 'BUSINESS_OPS', 50, 'card-2'),
    ]
    const result = calculateCashflow(txns as any)
    expect(result.byCard['card-1'].total).toBe(300)
    expect(result.byCard['card-2'].total).toBe(50)
  })

  it('groups by category', () => {
    const txns = [
      makeTransaction('EXPENSE', 'FB_ADS', 400),
      makeTransaction('EXPENSE', 'FB_ADS', 100),
      makeTransaction('EXPENSE', 'FULFILLMENT', 200),
    ]
    const result = calculateCashflow(txns as any)
    expect(result.byCategory['FB_ADS']).toBe(500)
    expect(result.byCategory['FULFILLMENT']).toBe(200)
  })
})
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
npx jest __tests__/lib/cashflow.test.ts -t "calculateCashflow"
```

Expected: FAIL — `Cannot find module '@/lib/cashflow'`

- [ ] **Step 3: Create `src/lib/cashflow.ts`**

```typescript
import type { TransactionWithRelations, CashflowSummary } from '@/types'

export function calculateCashflow(transactions: TransactionWithRelations[]): CashflowSummary {
  let totalIncome = 0
  let totalExpense = 0
  const byCategory: Record<string, number> = {}
  const byCard: Record<string, { name: string; total: number }> = {}
  const byMonthMap: Record<string, { income: number; expense: number }> = {}

  for (const t of transactions) {
    const month = t.date.toISOString().slice(0, 7) // "YYYY-MM"
    if (!byMonthMap[month]) byMonthMap[month] = { income: 0, expense: 0 }

    if (t.type === 'INCOME') {
      totalIncome += t.amount
      byMonthMap[month].income += t.amount
    } else {
      totalExpense += t.amount
      byMonthMap[month].expense += t.amount
      byCategory[t.category] = (byCategory[t.category] ?? 0) + t.amount
      if (t.cardId && t.card) {
        if (!byCard[t.cardId]) byCard[t.cardId] = { name: t.card.name, total: 0 }
        byCard[t.cardId].total += t.amount
      }
    }
  }

  const byMonth = Object.entries(byMonthMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, v]) => ({ month, ...v }))

  return { totalIncome, totalExpense, net: totalIncome - totalExpense, byCategory, byCard, byMonth }
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
npx jest __tests__/lib/cashflow.test.ts -t "calculateCashflow"
```

Expected: 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: cashflow calculation engine with category and card grouping"
```

---

## Task 6: Project APIs

**Files:**
- Create: `src/app/api/projects/route.ts`, `src/app/api/projects/[id]/route.ts`
- Create: `src/app/api/projects/[id]/cashflow/route.ts`
- Create: `src/app/api/projects/[id]/members/route.ts`

- [ ] **Step 1: Create helper `src/lib/project-access.ts`**

```typescript
import { getSession } from './auth'
import { prisma } from './prisma'
import { ProjectRole } from '@prisma/client'

export async function getUserProjectRole(projectId: string): Promise<ProjectRole | null> {
  const session = await getSession()
  if (!session?.user) return null
  const userId = (session.user as any).id
  const systemRole = (session.user as any).role
  if (systemRole === 'ADMIN') return ProjectRole.OWNER
  const member = await prisma.projectMember.findUnique({ where: { projectId_userId: { projectId, userId } } })
  return member?.role ?? null
}

export async function requireProjectRole(projectId: string, minRole: ProjectRole) {
  const role = await getUserProjectRole(projectId)
  const order: ProjectRole[] = [ProjectRole.VIEWER, ProjectRole.EDITOR, ProjectRole.OWNER]
  if (!role || order.indexOf(role) < order.indexOf(minRole)) return null
  return role
}
```

- [ ] **Step 2: Create `src/app/api/projects/route.ts`**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { getSession } from '@/lib/auth'

const createSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  startDate: z.string().datetime(),
})

export async function GET() {
  const session = await getSession()
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const userId = (session.user as any).id
  const role = (session.user as any).role

  const projects = role === 'ADMIN'
    ? await prisma.project.findMany({ include: { members: { include: { user: { select: { id: true, email: true, name: true } } } } }, orderBy: { createdAt: 'desc' } })
    : await prisma.project.findMany({
        where: { members: { some: { userId } } },
        include: { members: { include: { user: { select: { id: true, email: true, name: true } } } } },
        orderBy: { createdAt: 'desc' },
      })

  return NextResponse.json(projects)
}

export async function POST(req: NextRequest) {
  const session = await getSession()
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const userId = (session.user as any).id

  const body = await req.json()
  const parsed = createSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })

  const project = await prisma.project.create({
    data: {
      ...parsed.data,
      startDate: new Date(parsed.data.startDate),
      members: { create: { userId, role: 'OWNER' } },
    },
  })
  return NextResponse.json(project, { status: 201 })
}
```

- [ ] **Step 3: Create `src/app/api/projects/[id]/route.ts`**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { requireProjectRole } from '@/lib/project-access'

const updateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().optional(),
  startDate: z.string().datetime().optional(),
  status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
})

export async function GET(_: NextRequest, { params }: { params: { id: string } }) {
  const role = await requireProjectRole(params.id, 'VIEWER')
  if (!role) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const project = await prisma.project.findUnique({
    where: { id: params.id },
    include: { members: { include: { user: { select: { id: true, email: true, name: true } } } } },
  })
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(project)
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const role = await requireProjectRole(params.id, 'OWNER')
  if (!role) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const body = await req.json()
  const parsed = updateSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })

  const data: any = { ...parsed.data }
  if (data.startDate) data.startDate = new Date(data.startDate)

  const project = await prisma.project.update({ where: { id: params.id }, data })
  return NextResponse.json(project)
}

export async function DELETE(_: NextRequest, { params }: { params: { id: string } }) {
  const role = await requireProjectRole(params.id, 'OWNER')
  if (!role) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  await prisma.project.delete({ where: { id: params.id } })
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 4: Create `src/app/api/projects/[id]/cashflow/route.ts`**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireProjectRole } from '@/lib/project-access'
import { calculateCashflow } from '@/lib/cashflow'

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const role = await requireProjectRole(params.id, 'VIEWER')
  if (!role) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { searchParams } = new URL(req.url)
  const from = searchParams.get('from')
  const to = searchParams.get('to')

  const transactions = await prisma.transaction.findMany({
    where: {
      projectId: params.id,
      ...(from || to ? { date: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } } : {}),
    },
    include: {
      card: true,
      labels: { include: { label: true } },
      createdBy: { select: { id: true, email: true, name: true } },
    },
    orderBy: { date: 'desc' },
  })

  return NextResponse.json(calculateCashflow(transactions as any))
}
```

- [ ] **Step 5: Create `src/app/api/projects/[id]/members/route.ts`**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { requireProjectRole } from '@/lib/project-access'

const addSchema = z.object({ email: z.string().email(), role: z.enum(['EDITOR', 'VIEWER']) })

export async function GET(_: NextRequest, { params }: { params: { id: string } }) {
  const role = await requireProjectRole(params.id, 'VIEWER')
  if (!role) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const members = await prisma.projectMember.findMany({
    where: { projectId: params.id },
    include: { user: { select: { id: true, email: true, name: true } } },
  })
  return NextResponse.json(members)
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const role = await requireProjectRole(params.id, 'OWNER')
  if (!role) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const body = await req.json()
  const parsed = addSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })

  const user = await prisma.user.findUnique({ where: { email: parsed.data.email } })
  if (!user) return NextResponse.json({ error: 'User không tồn tại' }, { status: 404 })

  const member = await prisma.projectMember.upsert({
    where: { projectId_userId: { projectId: params.id, userId: user.id } },
    update: { role: parsed.data.role },
    create: { projectId: params.id, userId: user.id, role: parsed.data.role },
    include: { user: { select: { id: true, email: true, name: true } } },
  })
  return NextResponse.json(member, { status: 201 })
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const role = await requireProjectRole(params.id, 'OWNER')
  if (!role) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const { userId } = await req.json()
  await prisma.projectMember.delete({ where: { projectId_userId: { projectId: params.id, userId } } })
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: project CRUD, cashflow API, member management endpoints"
```

---

## Task 7: Transaction & Label APIs

**Files:**
- Create: `src/app/api/projects/[id]/transactions/route.ts`
- Create: `src/app/api/transactions/[id]/route.ts`
- Create: `src/app/api/projects/[id]/labels/route.ts`

- [ ] **Step 1: Create `src/app/api/projects/[id]/transactions/route.ts`**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { getSession } from '@/lib/auth'
import { requireProjectRole } from '@/lib/project-access'

const createSchema = z.object({
  type: z.enum(['INCOME', 'EXPENSE']),
  category: z.enum(['SHOPIFY_PAYOUT', 'PAYPAL', 'STRIPE', 'FB_ADS', 'FULFILLMENT', 'BUSINESS_OPS']),
  amount: z.number().positive(),
  currency: z.string().length(3).default('USD'),
  date: z.string().datetime(),
  description: z.string().optional(),
  cardId: z.string().optional(),
  labelIds: z.array(z.string()).default([]),
})

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const role = await requireProjectRole(params.id, 'VIEWER')
  if (!role) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { searchParams } = new URL(req.url)
  const category = searchParams.get('category')
  const cardId = searchParams.get('cardId')
  const labelId = searchParams.get('labelId')
  const from = searchParams.get('from')
  const to = searchParams.get('to')
  const type = searchParams.get('type')

  const transactions = await prisma.transaction.findMany({
    where: {
      projectId: params.id,
      ...(category ? { category: category as any } : {}),
      ...(cardId ? { cardId } : {}),
      ...(type ? { type: type as any } : {}),
      ...(labelId ? { labels: { some: { labelId } } } : {}),
      ...(from || to ? { date: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } } : {}),
    },
    include: {
      card: true,
      labels: { include: { label: true } },
      createdBy: { select: { id: true, email: true, name: true } },
    },
    orderBy: { date: 'desc' },
  })

  return NextResponse.json(transactions)
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getSession()
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const role = await requireProjectRole(params.id, 'EDITOR')
  if (!role) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const body = await req.json()
  const parsed = createSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })

  const { labelIds, ...data } = parsed.data
  const transaction = await prisma.transaction.create({
    data: {
      ...data,
      date: new Date(data.date),
      projectId: params.id,
      createdById: (session.user as any).id,
      labels: labelIds.length ? { create: labelIds.map(labelId => ({ labelId })) } : undefined,
    },
    include: { card: true, labels: { include: { label: true } }, createdBy: { select: { id: true, email: true, name: true } } },
  })
  return NextResponse.json(transaction, { status: 201 })
}
```

- [ ] **Step 2: Create `src/app/api/transactions/[id]/route.ts`**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { requireProjectRole } from '@/lib/project-access'

const updateSchema = z.object({
  amount: z.number().positive().optional(),
  date: z.string().datetime().optional(),
  description: z.string().optional(),
  cardId: z.string().nullable().optional(),
  labelIds: z.array(z.string()).optional(),
})

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const transaction = await prisma.transaction.findUnique({ where: { id: params.id } })
  if (!transaction) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const role = await requireProjectRole(transaction.projectId, 'EDITOR')
  if (!role) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const body = await req.json()
  const parsed = updateSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })

  const { labelIds, date, ...rest } = parsed.data

  await prisma.$transaction(async tx => {
    if (labelIds !== undefined) {
      await tx.transactionLabel.deleteMany({ where: { transactionId: params.id } })
      if (labelIds.length) await tx.transactionLabel.createMany({ data: labelIds.map(labelId => ({ transactionId: params.id, labelId })) })
    }
    await tx.transaction.update({
      where: { id: params.id },
      data: { ...rest, ...(date ? { date: new Date(date) } : {}) },
    })
  })

  const updated = await prisma.transaction.findUnique({
    where: { id: params.id },
    include: { card: true, labels: { include: { label: true } }, createdBy: { select: { id: true, email: true, name: true } } },
  })
  return NextResponse.json(updated)
}

export async function DELETE(_: NextRequest, { params }: { params: { id: string } }) {
  const transaction = await prisma.transaction.findUnique({ where: { id: params.id } })
  if (!transaction) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const role = await requireProjectRole(transaction.projectId, 'OWNER')
  if (!role) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  await prisma.transaction.delete({ where: { id: params.id } })
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 3: Create `src/app/api/projects/[id]/labels/route.ts`**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { requireProjectRole } from '@/lib/project-access'

const schema = z.object({ name: z.string().min(1).max(50), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#6366f1') })

export async function GET(_: NextRequest, { params }: { params: { id: string } }) {
  const role = await requireProjectRole(params.id, 'VIEWER')
  if (!role) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const labels = await prisma.label.findMany({ where: { projectId: params.id }, orderBy: { name: 'asc' } })
  return NextResponse.json(labels)
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const role = await requireProjectRole(params.id, 'EDITOR')
  if (!role) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const body = await req.json()
  const parsed = schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  const label = await prisma.label.create({ data: { ...parsed.data, projectId: params.id } })
  return NextResponse.json(label, { status: 201 })
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const role = await requireProjectRole(params.id, 'OWNER')
  if (!role) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const { labelId } = await req.json()
  await prisma.label.delete({ where: { id: labelId } })
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: transaction CRUD with label assignment, label management API"
```

---

## Task 8: Card API

**Files:**
- Create: `src/app/api/cards/route.ts`, `src/app/api/cards/[id]/route.ts`

- [ ] **Step 1: Create `src/app/api/cards/route.ts`**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { getSession } from '@/lib/auth'

const schema = z.object({
  name: z.string().min(1).max(100),
  last4: z.string().length(4).optional(),
  bankName: z.string().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#6366f1'),
  creditLimit: z.number().positive().optional(),
})

export async function GET() {
  const session = await getSession()
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const cards = await prisma.card.findMany({ orderBy: { name: 'asc' } })
  return NextResponse.json(cards)
}

export async function POST(req: NextRequest) {
  const session = await getSession()
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await req.json()
  const parsed = schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  const card = await prisma.card.create({ data: parsed.data })
  return NextResponse.json(card, { status: 201 })
}
```

- [ ] **Step 2: Create `src/app/api/cards/[id]/route.ts`**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { getSession } from '@/lib/auth'

const updateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  last4: z.string().length(4).optional(),
  bankName: z.string().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  creditLimit: z.number().positive().nullable().optional(),
})

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getSession()
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await req.json()
  const parsed = updateSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  const card = await prisma.card.update({ where: { id: params.id }, data: parsed.data })
  return NextResponse.json(card)
}

export async function DELETE(_: NextRequest, { params }: { params: { id: string } }) {
  const session = await getSession()
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const role = (session.user as any).role
  if (role !== 'ADMIN') return NextResponse.json({ error: 'Admin only' }, { status: 403 })
  await prisma.card.delete({ where: { id: params.id } })
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: card CRUD API (global, shared across projects)"
```

---

## Task 9: File Upload API

**Files:**
- Create: `src/app/api/upload/route.ts`

- [ ] **Step 1: Create upload directory**

```bash
mkdir -p public/uploads
echo "uploads/" >> .gitignore
```

- [ ] **Step 2: Create `src/app/api/upload/route.ts`**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { writeFile, mkdir } from 'fs/promises'
import path from 'path'
import { getSession } from '@/lib/auth'

const MAX_SIZE = 10 * 1024 * 1024 // 10MB
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']

export async function POST(req: NextRequest) {
  const session = await getSession()
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const formData = await req.formData()
  const file = formData.get('file') as File | null
  if (!file) return NextResponse.json({ error: 'Không có file' }, { status: 400 })
  if (file.size > MAX_SIZE) return NextResponse.json({ error: 'File quá lớn (max 10MB)' }, { status: 400 })
  if (!ALLOWED_TYPES.includes(file.type)) return NextResponse.json({ error: 'Chỉ chấp nhận JPG, PNG, PDF' }, { status: 400 })

  const bytes = await file.arrayBuffer()
  const ext = file.name.split('.').pop()
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
  const uploadDir = path.join(process.cwd(), 'public', 'uploads')
  await mkdir(uploadDir, { recursive: true })
  await writeFile(path.join(uploadDir, filename), Buffer.from(bytes))

  return NextResponse.json({ url: `/uploads/${filename}` }, { status: 201 })
}
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: file upload API for fulfillment invoices (JPG/PNG/PDF, 10MB limit)"
```

---

## Task 10: Dashboard Layout & Navigation

**Files:**
- Create: `src/components/layout/sidebar.tsx`, `src/components/layout/top-bar.tsx`
- Create: `src/app/(dashboard)/layout.tsx`

- [ ] **Step 1: Create `src/components/layout/sidebar.tsx`**

```tsx
'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { LayoutDashboard, FolderKanban, CreditCard, LogOut } from 'lucide-react'
import { signOut } from 'next-auth/react'
import { cn } from '@/lib/utils'

const navItems = [
  { href: '/', label: 'Tổng quan', icon: LayoutDashboard },
  { href: '/projects', label: 'Dự án', icon: FolderKanban },
  { href: '/cards', label: 'Thẻ thanh toán', icon: CreditCard },
]

export function Sidebar() {
  const pathname = usePathname()
  return (
    <aside className="w-56 min-h-screen bg-gray-900 text-white flex flex-col">
      <div className="p-4 border-b border-gray-700">
        <span className="font-bold text-lg">Cashflow</span>
      </div>
      <nav className="flex-1 p-3 space-y-1">
        {navItems.map(({ href, label, icon: Icon }) => (
          <Link key={href} href={href} className={cn(
            'flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors',
            pathname === href ? 'bg-indigo-600 text-white' : 'text-gray-300 hover:bg-gray-800'
          )}>
            <Icon size={16} />
            {label}
          </Link>
        ))}
      </nav>
      <div className="p-3 border-t border-gray-700">
        <button onClick={() => signOut({ callbackUrl: '/login' })}
          className="flex items-center gap-3 px-3 py-2 rounded-md text-sm text-gray-300 hover:bg-gray-800 w-full">
          <LogOut size={16} />
          Đăng xuất
        </button>
      </div>
    </aside>
  )
}
```

- [ ] **Step 2: Create `src/components/layout/top-bar.tsx`**

```tsx
import { getSession } from '@/lib/auth'

export async function TopBar({ title }: { title?: string }) {
  const session = await getSession()
  return (
    <header className="h-14 border-b bg-white flex items-center justify-between px-6">
      <h1 className="font-semibold text-gray-800">{title ?? 'Dashboard'}</h1>
      <div className="text-sm text-gray-500">{session?.user?.email}</div>
    </header>
  )
}
```

- [ ] **Step 3: Create `src/app/(dashboard)/layout.tsx`**

```tsx
import { Sidebar } from '@/components/layout/sidebar'
import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth'

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession()
  if (!session) redirect('/login')
  return (
    <div className="flex min-h-screen bg-gray-50">
      <Sidebar />
      <main className="flex-1 overflow-auto">{children}</main>
    </div>
  )
}
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: dashboard layout with sidebar navigation"
```

---

## Task 11: Cashflow UI Components

**Files:**
- Create: `src/components/cashflow/cashflow-summary.tsx`
- Create: `src/components/cashflow/cashflow-chart.tsx`
- Create: `src/components/cashflow/category-breakdown.tsx`

- [ ] **Step 1: Create `src/components/cashflow/cashflow-summary.tsx`**

```tsx
import type { CashflowSummary } from '@/types'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { TrendingUp, TrendingDown, DollarSign } from 'lucide-react'

function fmt(n: number, currency = 'USD') {
  return new Intl.NumberFormat('vi-VN', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n)
}

export function CashflowSummary({ data, currency = 'USD' }: { data: CashflowSummary; currency?: string }) {
  const cards = [
    { title: 'Tổng thu', value: data.totalIncome, icon: TrendingUp, color: 'text-green-600' },
    { title: 'Tổng chi', value: data.totalExpense, icon: TrendingDown, color: 'text-red-600' },
    { title: 'Cashflow thực tế', value: data.net, icon: DollarSign, color: data.net >= 0 ? 'text-green-700' : 'text-red-700' },
  ]
  return (
    <div className="grid grid-cols-3 gap-4">
      {cards.map(({ title, value, icon: Icon, color }) => (
        <Card key={title}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-gray-500 flex items-center gap-2">
              <Icon size={16} className={color} />
              {title}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${color}`}>{fmt(value, currency)}</div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
```

- [ ] **Step 2: Create `src/components/cashflow/cashflow-chart.tsx`**

```tsx
'use client'
import { LineChart, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid } from 'recharts'
import type { CashflowSummary } from '@/types'

export function CashflowChart({ data }: { data: CashflowSummary }) {
  const chartData = data.byMonth.map(m => ({
    month: m.month,
    'Thu': m.income,
    'Chi': m.expense,
    'Net': m.income - m.expense,
  }))

  return (
    <div className="h-72">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="month" tick={{ fontSize: 12 }} />
          <YAxis tick={{ fontSize: 12 }} />
          <Tooltip formatter={(v: number) => v.toLocaleString('vi-VN')} />
          <Legend />
          <Line type="monotone" dataKey="Thu" stroke="#10b981" strokeWidth={2} dot={false} />
          <Line type="monotone" dataKey="Chi" stroke="#ef4444" strokeWidth={2} dot={false} />
          <Line type="monotone" dataKey="Net" stroke="#6366f1" strokeWidth={2} strokeDasharray="5 5" dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
```

- [ ] **Step 3: Create `src/components/cashflow/category-breakdown.tsx`**

```tsx
import type { CashflowSummary } from '@/types'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

const CATEGORY_LABELS: Record<string, string> = {
  SHOPIFY_PAYOUT: 'Shopify Payout',
  PAYPAL: 'PayPal',
  STRIPE: 'Stripe',
  FB_ADS: 'Facebook Ads',
  FULFILLMENT: 'Fulfillment',
  BUSINESS_OPS: 'Chi phí vận hành',
}

const CATEGORY_COLORS: Record<string, string> = {
  FB_ADS: 'bg-blue-500',
  FULFILLMENT: 'bg-orange-500',
  BUSINESS_OPS: 'bg-purple-500',
  SHOPIFY_PAYOUT: 'bg-green-500',
  PAYPAL: 'bg-sky-500',
  STRIPE: 'bg-indigo-500',
}

export function CategoryBreakdown({ data }: { data: CashflowSummary }) {
  const total = Object.values(data.byCategory).reduce((a, b) => a + b, 0)
  return (
    <Card>
      <CardHeader><CardTitle className="text-sm">Chi phí theo danh mục</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        {Object.entries(data.byCategory).sort(([, a], [, b]) => b - a).map(([cat, amount]) => (
          <div key={cat}>
            <div className="flex justify-between text-sm mb-1">
              <span>{CATEGORY_LABELS[cat] ?? cat}</span>
              <span className="font-medium">{amount.toLocaleString('vi-VN')} ({total > 0 ? ((amount / total) * 100).toFixed(1) : 0}%)</span>
            </div>
            <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
              <div className={`h-full ${CATEGORY_COLORS[cat] ?? 'bg-gray-400'} rounded-full`}
                style={{ width: total > 0 ? `${(amount / total) * 100}%` : '0%' }} />
            </div>
          </div>
        ))}
        {Object.keys(data.byCategory).length === 0 && (
          <p className="text-sm text-gray-400 text-center py-4">Chưa có dữ liệu chi phí</p>
        )}
      </CardContent>
    </Card>
  )
}
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: cashflow summary cards, line chart, category breakdown components"
```

---

## Task 12: Project Pages

**Files:**
- Create: `src/app/(dashboard)/projects/page.tsx`
- Create: `src/app/(dashboard)/projects/new/page.tsx`
- Create: `src/app/(dashboard)/projects/[id]/page.tsx`
- Create: `src/app/(dashboard)/projects/[id]/transactions/page.tsx`
- Create: `src/app/(dashboard)/projects/[id]/transactions/new/page.tsx`

- [ ] **Step 1: Create `src/app/(dashboard)/projects/page.tsx`**

```tsx
import Link from 'next/link'
import { prisma } from '@/lib/prisma'
import { getSession } from '@/lib/auth'
import { redirect } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Plus, CalendarDays } from 'lucide-react'

export default async function ProjectsPage() {
  const session = await getSession()
  if (!session?.user) redirect('/login')
  const userId = (session.user as any).id
  const role = (session.user as any).role

  const projects = role === 'ADMIN'
    ? await prisma.project.findMany({ include: { members: true, _count: { select: { transactions: true } } }, orderBy: { createdAt: 'desc' } })
    : await prisma.project.findMany({ where: { members: { some: { userId } } }, include: { members: true, _count: { select: { transactions: true } } }, orderBy: { createdAt: 'desc' } })

  return (
    <div className="p-6">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">Dự án</h1>
        <Link href="/projects/new"><Button><Plus size={16} className="mr-2" />Tạo dự án</Button></Link>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {projects.map(p => (
          <Link key={p.id} href={`/projects/${p.id}`}>
            <Card className="hover:shadow-md transition-shadow cursor-pointer">
              <CardHeader className="pb-2">
                <div className="flex justify-between items-start">
                  <CardTitle className="text-base">{p.name}</CardTitle>
                  <Badge variant={p.status === 'ACTIVE' ? 'default' : 'secondary'}>{p.status}</Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-2 text-sm text-gray-500">
                <div className="flex items-center gap-1"><CalendarDays size={12} />Bắt đầu: {new Date(p.startDate).toLocaleDateString('vi-VN')}</div>
                <div>{p._count.transactions} giao dịch · {p.members.length} thành viên</div>
              </CardContent>
            </Card>
          </Link>
        ))}
        {projects.length === 0 && <p className="text-gray-400 col-span-3 text-center py-12">Chưa có dự án nào.</p>}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Create `src/app/(dashboard)/projects/new/page.tsx`**

```tsx
'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export default function NewProjectPage() {
  const router = useRouter()
  const [form, setForm] = useState({ name: '', description: '', startDate: '' })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...form, startDate: new Date(form.startDate).toISOString() }),
    })
    setLoading(false)
    if (!res.ok) { const d = await res.json(); setError(d.error?.message ?? 'Lỗi tạo dự án') }
    else { const p = await res.json(); router.push(`/projects/${p.id}`) }
  }

  return (
    <div className="p-6 max-w-lg">
      <h1 className="text-2xl font-bold mb-6">Tạo dự án mới</h1>
      <Card>
        <CardContent className="pt-6">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div><Label>Tên dự án *</Label><Input value={form.name} onChange={e => setForm(f => ({...f, name: e.target.value}))} required /></div>
            <div><Label>Mô tả</Label><Input value={form.description} onChange={e => setForm(f => ({...f, description: e.target.value}))} /></div>
            <div><Label>Ngày bắt đầu *</Label><Input type="date" value={form.startDate} onChange={e => setForm(f => ({...f, startDate: e.target.value}))} required /></div>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <div className="flex gap-2">
              <Button type="submit" disabled={loading}>{loading ? 'Đang tạo...' : 'Tạo dự án'}</Button>
              <Button type="button" variant="outline" onClick={() => router.back()}>Hủy</Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
```

- [ ] **Step 3: Create `src/app/(dashboard)/projects/[id]/page.tsx`**

```tsx
import { notFound, redirect } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { getSession } from '@/lib/auth'
import { calculateCashflow } from '@/lib/cashflow'
import { CashflowSummary } from '@/components/cashflow/cashflow-summary'
import { CashflowChart } from '@/components/cashflow/cashflow-chart'
import { CategoryBreakdown } from '@/components/cashflow/category-breakdown'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Plus } from 'lucide-react'

export default async function ProjectPage({ params }: { params: { id: string } }) {
  const session = await getSession()
  if (!session?.user) redirect('/login')
  const userId = (session.user as any).id
  const systemRole = (session.user as any).role

  const project = await prisma.project.findUnique({
    where: { id: params.id },
    include: { members: { include: { user: { select: { id: true, email: true, name: true } } } } },
  })
  if (!project) notFound()

  const isMember = systemRole === 'ADMIN' || project.members.some(m => m.userId === userId)
  if (!isMember) redirect('/projects')

  const transactions = await prisma.transaction.findMany({
    where: { projectId: params.id },
    include: { card: true, labels: { include: { label: true } }, createdBy: { select: { id: true, email: true, name: true } } },
    orderBy: { date: 'desc' },
  })

  const cashflow = calculateCashflow(transactions as any)

  return (
    <div className="p-6 space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold">{project.name}</h1>
          <p className="text-sm text-gray-500">Bắt đầu: {new Date(project.startDate).toLocaleDateString('vi-VN')}</p>
        </div>
        <div className="flex gap-2">
          <Link href={`/projects/${params.id}/transactions/new`}>
            <Button size="sm"><Plus size={14} className="mr-1" />Thêm giao dịch</Button>
          </Link>
          <Link href={`/projects/${params.id}/transactions`}>
            <Button size="sm" variant="outline">Xem tất cả</Button>
          </Link>
        </div>
      </div>

      <CashflowSummary data={cashflow} />

      <div className="grid grid-cols-3 gap-4">
        <Card className="col-span-2">
          <CardHeader><CardTitle className="text-sm">Cashflow theo tháng</CardTitle></CardHeader>
          <CardContent><CashflowChart data={cashflow} /></CardContent>
        </Card>
        <CategoryBreakdown data={cashflow} />
      </div>

      {Object.keys(cashflow.byCard).length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-sm">Chi tiêu theo thẻ</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-2">
              {Object.entries(cashflow.byCard).map(([id, { name, total }]) => (
                <div key={id} className="flex justify-between text-sm py-1 border-b last:border-0">
                  <span>{name}</span>
                  <span className="font-medium text-red-600">{total.toLocaleString('vi-VN')}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle className="text-sm">Giao dịch gần nhất</CardTitle></CardHeader>
        <CardContent>
          <div className="space-y-2">
            {transactions.slice(0, 10).map(t => (
              <div key={t.id} className="flex justify-between items-center text-sm py-1 border-b last:border-0">
                <div>
                  <span className="font-medium">{t.description ?? t.category}</span>
                  <span className="ml-2 text-gray-400">{new Date(t.date).toLocaleDateString('vi-VN')}</span>
                </div>
                <span className={t.type === 'INCOME' ? 'text-green-600 font-medium' : 'text-red-600 font-medium'}>
                  {t.type === 'INCOME' ? '+' : '-'}{t.amount.toLocaleString('vi-VN')}
                </span>
              </div>
            ))}
            {transactions.length === 0 && <p className="text-gray-400 text-center py-4 text-sm">Chưa có giao dịch</p>}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
```

- [ ] **Step 4: Create `src/app/(dashboard)/projects/[id]/transactions/new/page.tsx`**

```tsx
'use client'
import { useState, useEffect } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Card, CardContent } from '@/components/ui/card'
import type { Card as CardType, Label as LabelType } from '@prisma/client'

const CATEGORIES = [
  { value: 'SHOPIFY_PAYOUT', label: 'Shopify Payout', type: 'INCOME' },
  { value: 'PAYPAL', label: 'PayPal', type: 'INCOME' },
  { value: 'STRIPE', label: 'Stripe', type: 'INCOME' },
  { value: 'FB_ADS', label: 'Facebook Ads', type: 'EXPENSE' },
  { value: 'FULFILLMENT', label: 'Fulfillment', type: 'EXPENSE' },
  { value: 'BUSINESS_OPS', label: 'Chi phí vận hành', type: 'EXPENSE' },
]

export default function NewTransactionPage() {
  const router = useRouter()
  const params = useParams()
  const projectId = params.id as string

  const [form, setForm] = useState({
    category: '',
    amount: '',
    currency: 'USD',
    date: new Date().toISOString().slice(0, 10),
    description: '',
    cardId: '',
    labelIds: [] as string[],
  })
  const [cards, setCards] = useState<CardType[]>([])
  const [labels, setLabels] = useState<LabelType[]>([])
  const [file, setFile] = useState<File | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    fetch('/api/cards').then(r => r.json()).then(setCards)
    fetch(`/api/projects/${projectId}/labels`).then(r => r.json()).then(setLabels)
  }, [projectId])

  const selectedCat = CATEGORIES.find(c => c.value === form.category)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!selectedCat) return
    setLoading(true)
    setError('')

    let attachmentUrl: string | undefined
    if (file) {
      const fd = new FormData()
      fd.append('file', file)
      const up = await fetch('/api/upload', { method: 'POST', body: fd })
      if (!up.ok) { setLoading(false); setError('Upload thất bại'); return }
      const { url } = await up.json()
      attachmentUrl = url
    }

    const res = await fetch(`/api/projects/${projectId}/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: selectedCat.type,
        category: form.category,
        amount: parseFloat(form.amount),
        currency: form.currency,
        date: new Date(form.date).toISOString(),
        description: form.description || undefined,
        cardId: form.cardId || undefined,
        labelIds: form.labelIds,
        attachmentUrl,
      }),
    })
    setLoading(false)
    if (!res.ok) { const d = await res.json(); setError(JSON.stringify(d.error)) }
    else { router.push(`/projects/${projectId}/transactions`) }
  }

  return (
    <div className="p-6 max-w-lg">
      <h1 className="text-2xl font-bold mb-6">Thêm giao dịch</h1>
      <Card>
        <CardContent className="pt-6">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <Label>Danh mục *</Label>
              <Select onValueChange={v => setForm(f => ({...f, category: v}))}>
                <SelectTrigger><SelectValue placeholder="Chọn danh mục" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="income-header" disabled className="font-semibold text-green-600">— Thu —</SelectItem>
                  {CATEGORIES.filter(c => c.type === 'INCOME').map(c => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
                  <SelectItem value="expense-header" disabled className="font-semibold text-red-600">— Chi —</SelectItem>
                  {CATEGORIES.filter(c => c.type === 'EXPENSE').map(c => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            <div className="flex gap-2">
              <div className="flex-1"><Label>Số tiền *</Label><Input type="number" step="0.01" min="0" value={form.amount} onChange={e => setForm(f => ({...f, amount: e.target.value}))} required /></div>
              <div className="w-24">
                <Label>Tiền tệ</Label>
                <Select value={form.currency} onValueChange={v => setForm(f => ({...f, currency: v}))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {['USD','VND','EUR','GBP'].map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div><Label>Ngày *</Label><Input type="date" value={form.date} onChange={e => setForm(f => ({...f, date: e.target.value}))} required /></div>
            <div><Label>Mô tả</Label><Input value={form.description} onChange={e => setForm(f => ({...f, description: e.target.value}))} /></div>

            <div>
              <Label>Thẻ thanh toán</Label>
              <Select onValueChange={v => setForm(f => ({...f, cardId: v}))}>
                <SelectTrigger><SelectValue placeholder="Chọn thẻ (tùy chọn)" /></SelectTrigger>
                <SelectContent>
                  {cards.map(c => <SelectItem key={c.id} value={c.id}>{c.name}{c.last4 ? ` *${c.last4}` : ''}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            {labels.length > 0 && (
              <div>
                <Label>Labels</Label>
                <div className="flex flex-wrap gap-2 mt-1">
                  {labels.map(l => (
                    <button key={l.id} type="button"
                      className={`px-2 py-1 rounded text-xs border transition-colors ${form.labelIds.includes(l.id) ? 'text-white border-transparent' : 'bg-white text-gray-600'}`}
                      style={form.labelIds.includes(l.id) ? { backgroundColor: l.color, borderColor: l.color } : { borderColor: l.color }}
                      onClick={() => setForm(f => ({ ...f, labelIds: f.labelIds.includes(l.id) ? f.labelIds.filter(id => id !== l.id) : [...f.labelIds, l.id] }))}>
                      {l.name}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div>
              <Label>Đính kèm hóa đơn (JPG/PNG/PDF)</Label>
              <Input type="file" accept=".jpg,.jpeg,.png,.pdf" onChange={e => setFile(e.target.files?.[0] ?? null)} />
            </div>

            {error && <p className="text-sm text-red-600">{error}</p>}
            <div className="flex gap-2">
              <Button type="submit" disabled={loading || !form.category || !form.amount}>{loading ? 'Đang lưu...' : 'Lưu giao dịch'}</Button>
              <Button type="button" variant="outline" onClick={() => router.back()}>Hủy</Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
```

- [ ] **Step 5: Create `src/app/(dashboard)/projects/[id]/transactions/page.tsx`**

```tsx
import { prisma } from '@/lib/prisma'
import { getSession } from '@/lib/auth'
import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Plus } from 'lucide-react'

const CATEGORY_LABEL: Record<string, string> = {
  SHOPIFY_PAYOUT: 'Shopify', PAYPAL: 'PayPal', STRIPE: 'Stripe',
  FB_ADS: 'Facebook Ads', FULFILLMENT: 'Fulfillment', BUSINESS_OPS: 'Vận hành',
}

export default async function TransactionsPage({ params, searchParams }: { params: { id: string }; searchParams: { category?: string; cardId?: string } }) {
  const session = await getSession()
  if (!session?.user) redirect('/login')
  const userId = (session.user as any).id
  const systemRole = (session.user as any).role

  const project = await prisma.project.findUnique({ where: { id: params.id } })
  if (!project) notFound()

  const isMember = systemRole === 'ADMIN' || await prisma.projectMember.findUnique({ where: { projectId_userId: { projectId: params.id, userId } } })
  if (!isMember) redirect('/projects')

  const transactions = await prisma.transaction.findMany({
    where: {
      projectId: params.id,
      ...(searchParams.category ? { category: searchParams.category as any } : {}),
      ...(searchParams.cardId ? { cardId: searchParams.cardId } : {}),
    },
    include: { card: true, labels: { include: { label: true } }, createdBy: { select: { id: true, email: true, name: true } } },
    orderBy: { date: 'desc' },
  })

  return (
    <div className="p-6">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-xl font-bold">Giao dịch — {project.name}</h1>
        <Link href={`/projects/${params.id}/transactions/new`}>
          <Button size="sm"><Plus size={14} className="mr-1" />Thêm</Button>
        </Link>
      </div>

      <div className="border rounded-lg overflow-hidden bg-white">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="text-left px-4 py-3 font-medium text-gray-500">Ngày</th>
              <th className="text-left px-4 py-3 font-medium text-gray-500">Danh mục</th>
              <th className="text-left px-4 py-3 font-medium text-gray-500">Mô tả</th>
              <th className="text-left px-4 py-3 font-medium text-gray-500">Thẻ</th>
              <th className="text-left px-4 py-3 font-medium text-gray-500">Labels</th>
              <th className="text-right px-4 py-3 font-medium text-gray-500">Số tiền</th>
            </tr>
          </thead>
          <tbody>
            {transactions.map(t => (
              <tr key={t.id} className="border-b last:border-0 hover:bg-gray-50">
                <td className="px-4 py-3 text-gray-500">{new Date(t.date).toLocaleDateString('vi-VN')}</td>
                <td className="px-4 py-3"><Badge variant="outline">{CATEGORY_LABEL[t.category]}</Badge></td>
                <td className="px-4 py-3 text-gray-700">{t.description ?? '—'}</td>
                <td className="px-4 py-3 text-gray-500">{t.card ? `${t.card.name}${t.card.last4 ? ` *${t.card.last4}` : ''}` : '—'}</td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1">
                    {t.labels.map(({ label }) => (
                      <span key={label.id} className="px-1.5 py-0.5 rounded text-xs text-white" style={{ backgroundColor: label.color }}>{label.name}</span>
                    ))}
                  </div>
                </td>
                <td className={`px-4 py-3 text-right font-medium ${t.type === 'INCOME' ? 'text-green-600' : 'text-red-600'}`}>
                  {t.type === 'INCOME' ? '+' : '-'}{t.amount.toLocaleString('vi-VN')} {t.currency}
                </td>
              </tr>
            ))}
            {transactions.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-12 text-center text-gray-400">Chưa có giao dịch nào</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: project list, detail dashboard, transaction list and create form"
```

---

## Task 13: Cards Pages

**Files:**
- Create: `src/app/(dashboard)/cards/page.tsx`
- Create: `src/app/(dashboard)/cards/new/page.tsx`

- [ ] **Step 1: Create `src/app/(dashboard)/cards/page.tsx`**

```tsx
import { prisma } from '@/lib/prisma'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Plus, CreditCard } from 'lucide-react'

export default async function CardsPage() {
  const cards = await prisma.card.findMany({
    include: { _count: { select: { transactions: true } } },
    orderBy: { name: 'asc' },
  })

  const cardTotals = await prisma.transaction.groupBy({
    by: ['cardId'],
    where: { type: 'EXPENSE', cardId: { not: null } },
    _sum: { amount: true },
  })
  const totalByCard = Object.fromEntries(cardTotals.map(t => [t.cardId!, t._sum.amount ?? 0]))

  return (
    <div className="p-6">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">Thẻ thanh toán</h1>
        <Link href="/cards/new"><Button><Plus size={16} className="mr-2" />Thêm thẻ</Button></Link>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {cards.map(card => (
          <Card key={card.id}>
            <CardHeader className="pb-2">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-full flex items-center justify-center text-white" style={{ backgroundColor: card.color }}>
                  <CreditCard size={14} />
                </div>
                <CardTitle className="text-base">{card.name}</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-1 text-sm text-gray-500">
              {card.last4 && <div>Số thẻ: **** **** **** {card.last4}</div>}
              {card.bankName && <div>Ngân hàng: {card.bankName}</div>}
              <div className="text-red-600 font-semibold">Tổng chi: {(totalByCard[card.id] ?? 0).toLocaleString('vi-VN')}</div>
              <div>{card._count.transactions} giao dịch</div>
            </CardContent>
          </Card>
        ))}
        {cards.length === 0 && <p className="text-gray-400 col-span-3 text-center py-12">Chưa có thẻ nào.</p>}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Create `src/app/(dashboard)/cards/new/page.tsx`**

```tsx
'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent } from '@/components/ui/card'

export default function NewCardPage() {
  const router = useRouter()
  const [form, setForm] = useState({ name: '', last4: '', bankName: '', color: '#6366f1', creditLimit: '' })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    const res = await fetch('/api/cards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...form, last4: form.last4 || undefined, bankName: form.bankName || undefined, creditLimit: form.creditLimit ? parseFloat(form.creditLimit) : undefined }),
    })
    setLoading(false)
    if (!res.ok) { const d = await res.json(); setError(JSON.stringify(d.error)) }
    else { router.push('/cards') }
  }

  return (
    <div className="p-6 max-w-lg">
      <h1 className="text-2xl font-bold mb-6">Thêm thẻ thanh toán</h1>
      <Card>
        <CardContent className="pt-6">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div><Label>Tên thẻ *</Label><Input value={form.name} onChange={e => setForm(f => ({...f, name: e.target.value}))} placeholder="Visa ACB" required /></div>
            <div><Label>4 số cuối</Label><Input value={form.last4} onChange={e => setForm(f => ({...f, last4: e.target.value.slice(0,4)}))} placeholder="1234" maxLength={4} /></div>
            <div><Label>Ngân hàng</Label><Input value={form.bankName} onChange={e => setForm(f => ({...f, bankName: e.target.value}))} placeholder="ACB" /></div>
            <div><Label>Màu</Label><input type="color" value={form.color} onChange={e => setForm(f => ({...f, color: e.target.value}))} className="h-10 w-20 cursor-pointer rounded border" /></div>
            <div><Label>Hạn mức tín dụng</Label><Input type="number" value={form.creditLimit} onChange={e => setForm(f => ({...f, creditLimit: e.target.value}))} placeholder="0" /></div>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <div className="flex gap-2">
              <Button type="submit" disabled={loading}>{loading ? 'Đang lưu...' : 'Lưu thẻ'}</Button>
              <Button type="button" variant="outline" onClick={() => router.back()}>Hủy</Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: cards listing and create pages with total spend tracking"
```

---

## Task 14: Global Dashboard & Final Polish

**Files:**
- Create: `src/app/(dashboard)/page.tsx`

- [ ] **Step 1: Create `src/app/(dashboard)/page.tsx`**

```tsx
import { prisma } from '@/lib/prisma'
import { getSession } from '@/lib/auth'
import { redirect } from 'next/navigation'
import { calculateCashflow } from '@/lib/cashflow'
import Link from 'next/link'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

export default async function DashboardPage() {
  const session = await getSession()
  if (!session?.user) redirect('/login')
  const userId = (session.user as any).id
  const systemRole = (session.user as any).role

  const projects = systemRole === 'ADMIN'
    ? await prisma.project.findMany({ where: { status: 'ACTIVE' } })
    : await prisma.project.findMany({ where: { status: 'ACTIVE', members: { some: { userId } } } })

  const allTxns = await prisma.transaction.findMany({
    where: { projectId: { in: projects.map(p => p.id) } },
    include: { card: true, labels: { include: { label: true } }, createdBy: { select: { id: true, email: true, name: true } } },
  })

  const globalCashflow = calculateCashflow(allTxns as any)

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-bold">Tổng quan</h1>

      <div className="grid grid-cols-3 gap-4">
        <Card><CardHeader className="pb-2"><CardTitle className="text-sm text-gray-500">Tổng thu (tất cả dự án)</CardTitle></CardHeader>
          <CardContent><div className="text-2xl font-bold text-green-600">{globalCashflow.totalIncome.toLocaleString('vi-VN')}</div></CardContent>
        </Card>
        <Card><CardHeader className="pb-2"><CardTitle className="text-sm text-gray-500">Tổng chi (tất cả dự án)</CardTitle></CardHeader>
          <CardContent><div className="text-2xl font-bold text-red-600">{globalCashflow.totalExpense.toLocaleString('vi-VN')}</div></CardContent>
        </Card>
        <Card><CardHeader className="pb-2"><CardTitle className="text-sm text-gray-500">Net cashflow</CardTitle></CardHeader>
          <CardContent><div className={`text-2xl font-bold ${globalCashflow.net >= 0 ? 'text-green-700' : 'text-red-700'}`}>{globalCashflow.net.toLocaleString('vi-VN')}</div></CardContent>
        </Card>
      </div>

      <div>
        <h2 className="text-lg font-semibold mb-3">Dự án đang hoạt động ({projects.length})</h2>
        <div className="space-y-2">
          {projects.map(p => (
            <Link key={p.id} href={`/projects/${p.id}`} className="block border rounded-lg p-4 bg-white hover:shadow-sm transition-shadow">
              <div className="flex justify-between items-center">
                <span className="font-medium">{p.name}</span>
                <Badge variant="default">ACTIVE</Badge>
              </div>
              <div className="text-sm text-gray-500 mt-1">Bắt đầu: {new Date(p.startDate).toLocaleDateString('vi-VN')}</div>
            </Link>
          ))}
          {projects.length === 0 && <p className="text-gray-400 text-center py-8">Chưa có dự án nào.</p>}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Run all tests**

```bash
npx jest
```

Expected: All tests PASS

- [ ] **Step 3: Start dev server and verify full flow**

```bash
npm run dev
```

Test checklist:
- [ ] Login với `admin@ecom.local` / `admin123` → redirect to `/`
- [ ] Tạo project mới → redirect to project detail
- [ ] Thêm thẻ (Cards page) → hiện trong dropdown transaction form
- [ ] Thêm giao dịch INCOME (Shopify Payout, 1000 USD) → cashflow summary update
- [ ] Thêm giao dịch EXPENSE (FB Ads, 400 USD, chọn thẻ) → cashflow net = 600
- [ ] Chart hiển thị đúng theo tháng
- [ ] Cards page hiển thị total spent

- [ ] **Step 4: Final commit and push**

```bash
git add -A
git commit -m "feat: global dashboard with cross-project cashflow summary"
git push -u origin claude/ecommerce-cashflow-tool-XsLzh
```

---

## Self-Review

**Spec coverage check:**
- ✅ Cashflow formula: Shopify + PayPal + Stripe - FB_ADS - FULFILLMENT - BUSINESS_OPS → `calculateCashflow()` Task 5
- ✅ Label per transaction cho filter theo dự án → Task 7 + Transaction form Task 12
- ✅ Card tracking (total spent per card) → Task 8 + `byCard` in cashflow engine
- ✅ Multi-user + phân quyền ADMIN/OWNER/EDITOR/VIEWER → Task 4 + `project-access.ts` Task 6
- ✅ Manual entry (nhập tay) → Transaction form Task 12
- ✅ Upload hóa đơn (fulfillment) → Task 9 + form Task 12
- ✅ Dashboard cashflow chart theo tháng → Task 11
- ✅ Filter transaction theo category/card/label → GET `/api/projects/[id]/transactions` Task 7

**Placeholder scan:** Không có TBD/TODO trong code steps.

**Type consistency:** `TransactionWithRelations` sử dụng nhất quán từ Task 3 → Task 5 → Task 12.
