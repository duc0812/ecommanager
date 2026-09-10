import { NextRequest, NextResponse } from 'next/server'
import { AUTH_COOKIE, verifyToken } from '@/lib/auth'
import { canCallApi } from '@/lib/api-access'
import { canAccess } from '@/lib/roles'

const PUBLIC_PATHS = ['/login', '/api/auth/login', '/api/auth/shopify/callback']

function isApi(pathname: string) {
  return pathname.startsWith('/api/')
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl
  const method = req.method

  if (PUBLIC_PATHS.some(p => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next()
  }

  const token = req.cookies.get(AUTH_COOKIE)?.value
  const payload = token ? await verifyToken(token) : null

  if (isApi(pathname)) {
    const decision = canCallApi(payload?.role ?? null, payload?.permissions ?? [], pathname, method)
    if (decision === 'unauthenticated') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (decision === 'forbidden') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    return NextResponse.next()
  }

  if (!payload) {
    const login = new URL('/login', req.url)
    if (pathname !== '/') login.searchParams.set('next', pathname)
    return NextResponse.redirect(login)
  }

  if (!canAccess(payload.role, pathname, payload.permissions)) {
    return NextResponse.rewrite(new URL('/no-access', req.url), { status: 403 })
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|no-access).*)'],
}
