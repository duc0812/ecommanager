import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { APIFY_TOKEN_SETTING_KEY } from '@/lib/spy/apify'

export const dynamic = 'force-dynamic'

export async function GET() {
  const row = await prisma.appSetting.findUnique({ where: { key: APIFY_TOKEN_SETTING_KEY } })
  return NextResponse.json({ hasToken: Boolean(row?.value?.trim()) })
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const token = String(body.apifyToken ?? '').trim()
  if (!token) {
    await prisma.appSetting.deleteMany({ where: { key: APIFY_TOKEN_SETTING_KEY } })
    return NextResponse.json({ hasToken: false })
  }
  await prisma.appSetting.upsert({
    where: { key: APIFY_TOKEN_SETTING_KEY },
    create: { key: APIFY_TOKEN_SETTING_KEY, value: token },
    update: { value: token },
  })
  return NextResponse.json({ hasToken: true })
}
