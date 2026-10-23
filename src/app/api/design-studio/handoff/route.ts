import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, unauthorized } from '@/lib/api-auth'
import { viewerFor } from '@/lib/design-tasks'
import { getDesignSettings } from '@/lib/design-settings'
import { countPendingHandoff, listHandoffCards, listSentCards } from '@/lib/supplier-handoff'
import { SENT_STAGE_LABELS, type SentStage } from '@/lib/handoff-shared'

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!user) return unauthorized()
  const q = req.nextUrl.searchParams.get('q')?.trim() || undefined
  const settings = await getDesignSettings()
  const sp = req.nextUrl.searchParams
  if (sp.get('view') === 'sent') {
    const stageParam = sp.get('stage')
    const stage = stageParam && stageParam in SENT_STAGE_LABELS ? stageParam as SentStage : null
    return NextResponse.json({ ...(await listSentCards({ q, stage, supplierId: sp.get('supplier') || null })), me: viewerFor(user, settings) })
  }
  const [cards, pendingCount] = await Promise.all([listHandoffCards({ q }), countPendingHandoff()])
  return NextResponse.json({ ...cards, pendingCount, me: viewerFor(user, settings) })
}
