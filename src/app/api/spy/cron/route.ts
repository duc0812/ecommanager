import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { parseCronConfig, SPY_CRON_CONFIG_KEY } from '@/lib/spy/cron-config'
import { reloadSpyScheduler } from '@/lib/spy/scheduler'

export const dynamic = 'force-dynamic'

export async function GET() {
  const row = await prisma.appSetting.findUnique({ where: { key: SPY_CRON_CONFIG_KEY } })
  return NextResponse.json(parseCronConfig(row?.value))
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const cfg = parseCronConfig(JSON.stringify(body))
  await prisma.appSetting.upsert({
    where: { key: SPY_CRON_CONFIG_KEY },
    create: { key: SPY_CRON_CONFIG_KEY, value: JSON.stringify(cfg) },
    update: { value: JSON.stringify(cfg) },
  })
  await reloadSpyScheduler()
  return NextResponse.json(cfg)
}
