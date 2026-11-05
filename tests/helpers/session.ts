import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { AUTH_COOKIE, signToken } from '@/lib/auth'

const EMAIL = 'session-helper-super@test.local'

// A Super Admin session for a test that calls a route handler directly. Handlers read the caller's stores now,
// so a request without a session is a 401. Remove the user in afterAll with dropSessionUser().
export async function superCookie(): Promise<string> {
  process.env.AUTH_SECRET ||= 'test-secret-that-is-long-enough-32chars'
  const row = await prisma.appUser.upsert({
    where: { email: EMAIL }, create: { name: 'Session helper', email: EMAIL, role: 'SUPERADMIN', permissions: '[]' }, update: {},
  })
  const token = await signToken({ userId: row.id, email: EMAIL, name: 'Session helper', role: 'SUPERADMIN', permissions: [], tv: row.tokenVersion })
  return `${AUTH_COOKIE}=${token}`
}

export async function dropSessionUser() {
  await prisma.appUser.deleteMany({ where: { email: EMAIL } })
}

export async function superRequest(url: string, init: ConstructorParameters<typeof NextRequest>[1] = {}) {
  const headers = new Headers(init.headers)
  headers.set('cookie', await superCookie())
  return new NextRequest(url, { ...init, headers })
}
