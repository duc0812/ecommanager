import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireSuperadmin } from '@/lib/api-auth'
import { parseStoreRules, SPY_STORE_RULES_KEY } from '@/lib/spy/store-rules'
import { loadStoreRules } from '@/lib/spy/presumptions'

export const dynamic = 'force-dynamic'

// The per-store rules are the "why" behind each level, so only superadmins read them.
export async function GET(req: NextRequest) {
  const auth = await requireSuperadmin(req)
  if ('error' in auth) return auth.error
  return NextResponse.json(await loadStoreRules())
}

export async function POST(req: NextRequest) {
  const auth = await requireSuperadmin(req)
  if ('error' in auth) return auth.error
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'body must be { domain: rules }' }, { status: 400 })
  const rules = parseStoreRules(JSON.stringify(body))
  await prisma.appSetting.upsert({
    where: { key: SPY_STORE_RULES_KEY },
    create: { key: SPY_STORE_RULES_KEY, value: JSON.stringify(rules) },
    update: { value: JSON.stringify(rules) },
  })
  return NextResponse.json(rules)
}
