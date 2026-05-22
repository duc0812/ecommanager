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
