import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAccess, requireSuperadmin } from '@/lib/api-auth'
import { getCsSecrets, getCsSettings, saveCsSecrets, saveCsSettings, toCsSettingsView, type CsSettings } from '@/lib/cs/settings'
import { maskedForSuperadminOnly } from '@/lib/secret-view'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const auth = await requireApiAccess(req)
  if ('error' in auth) return auth.error
  const [settings, secrets, lastRun] = await Promise.all([getCsSettings(), getCsSecrets(), prisma.appSetting.findUnique({ where: { key: 'last_cs_run_result' } })])
  const view = maskedForSuperadminOnly(auth.user, toCsSettingsView(settings, secrets), ['freshdeskApiKeyMasked', 'anthropicApiKeyMasked', 'kieApiKeyMasked'])
  return NextResponse.json({ settings: view, lastRun: lastRun ? JSON.parse(lastRun.value) : null })
}

const PATCH_KEYS: (keyof CsSettings)[] = ['freshdeskDomain', 'llmProvider', 'model', 'pollEnabled', 'killSwitch', 'autoReplyEnabled', 'autoReplyCategories', 'autoReplyDailyCap', 'notifyLevels', 'productionDays', 'shippingDays', 'reviewEnabled', 'weeklyReport', 'reviewModel', 'llmDailyCallCap', 'afterHoursAutoReply', 'afterHoursCategories', 'businessHoursStart', 'businessHoursEnd', 'weekendIsAfterHours', 'workSaturdayAnchor']

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
