import { SignJWT, jwtVerify } from 'jose'
import { FeaturePermission, UserRole } from '@/lib/roles'

export type AuthPayload = {
  userId: string
  email: string
  name: string
  role: UserRole
  permissions: FeaturePermission[]
  tv?: number
}

export const AUTH_COOKIE = 'auth_token'
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24

function secret() {
  const s = process.env.AUTH_SECRET
  if (!s) throw new Error('AUTH_SECRET is not set')
  return new TextEncoder().encode(s)
}

export async function signToken(payload: AuthPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_SECONDS}s`)
    .sign(secret())
}

export async function verifyToken(token: string): Promise<AuthPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secret())
    if (typeof payload.userId !== 'string' || typeof payload.role !== 'string') return null
    return {
      userId: payload.userId,
      email: String(payload.email ?? ''),
      name: String(payload.name ?? ''),
      role: payload.role as UserRole,
      permissions: Array.isArray(payload.permissions) ? (payload.permissions as FeaturePermission[]) : [],
      tv: typeof payload.tv === 'number' ? payload.tv : 0,
    }
  } catch {
    return null
  }
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production' && (process.env.NEXT_PUBLIC_APP_URL ?? '').startsWith('https://'),
    maxAge: SESSION_MAX_AGE_SECONDS,
    path: '/',
  }
}

export function clearedSessionCookieOptions() {
  return { ...sessionCookieOptions(), maxAge: 0 }
}
