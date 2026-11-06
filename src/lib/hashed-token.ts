import crypto from 'crypto'
import { prisma } from '@/lib/db'

function sha256Hex(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex')
}

// Only the sha256 of the token is kept in AppSetting `key`; the token itself exists only in this return value.
export async function mintHashedToken(prefix: string, key: string): Promise<string> {
  const token = `${prefix}${crypto.randomBytes(32).toString('base64url')}`
  const value = sha256Hex(token)
  await prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } })
  return token
}

export async function revokeHashedToken(key: string): Promise<void> {
  await prisma.appSetting.deleteMany({ where: { key } })
}

export async function hashedTokenInfo(key: string): Promise<{ configured: boolean; updatedAt: string | null }> {
  const row = await prisma.appSetting.findUnique({ where: { key } })
  return { configured: !!row?.value, updatedAt: row?.updatedAt.toISOString() ?? null }
}

export async function verifyBearerHash(header: string | null, key: string): Promise<boolean> {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '')
  if (!m) return false
  const row = await prisma.appSetting.findUnique({ where: { key } })
  if (!row?.value || !/^[0-9a-f]{64}$/.test(row.value)) return false
  const expected = Buffer.from(row.value, 'hex')
  const actual = Buffer.from(sha256Hex(m[1]), 'hex')
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual)
}
