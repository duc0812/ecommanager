import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireSuperadmin } from '@/lib/api-auth'
import { getCsSecrets, getCsSettings, saveCsSecrets, saveCsSettings, toCsSettingsView, type CsSettings } from '@/lib/cs/settings'

export const dynamic = 'force-dynamic'

export async function GET() {
  const [settings, secrets, lastRun] = await Promise.all([getCsSettings(), getCsSecrets(), prisma.appSetting.findUnique({ where: { key: 'last_cs_run_result' } })])
  return NextResponse.json({ settings: toCsSettingsView(settings, secrets), lastRun: lastRun ? JSON.parse(lastRun.value) : null })
}

const PATCH_KEYS: (keyof CsSettings)[] = ['freshdeskDomain', 'llmProvider', 'model', 'pollEnabled', 'killSwitch', 'autoReplyEnabled', 'autoReplyCategories', 'autoReplyDailyCap', 'notifyLevels', 'productionDays', 'shippingDays', 'reviewEnabled', 'weeklyReport', 'reviewModel', 'llmDailyCallCap', 'afterHoursAutoReply', 'afterHoursCategories', 'businessHoursStart', 'businessHoursEnd', 'weekendIsAfterHours']

export async function POST(req: NextRequest) {
  const auth = await requireSuperadmin(req)
  if ('error' in auth) return auth.error
  const body = await req.json().catch(() => ({}))
  const patch: Partial<CsSettings> = {}
  for (const k of PATCH_KEYS) if (body[k] !== undefined) (patch as any)[k] = body[k]
  const settings = await saveCsSettings(patch)
  await saveCsSecrets({ freshdeskApiKey: body.freshdeskApiKey, anthropicApiKey: body.anthropicApiKey, kieApiKey: body.kieApiKey })
  return NextResponse.json({ settings: toCsSettingsView(settings, await getCsSecrets()) })
}
