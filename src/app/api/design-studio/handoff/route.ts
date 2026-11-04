import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, unauthorized } from '@/lib/api-auth'
import { viewerFor } from '@/lib/design-tasks'
import { getDesignSettings } from '@/lib/design-settings'
import { countPendingHandoff, listHandoffHub, listSentCards } from '@/lib/supplier-handoff'
import { SENT_STAGE_LABELS, type SentStage } from '@/lib/handoff-shared'
import { getSheetsConnection } from '@/lib/google-sheets'

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!user) return unauthorized()
  const q = req.nextUrl.searchParams.get('q')?.trim() || undefined
  const settings = await getDesignSettings()
  const sp = req.nextUrl.searchParams
  if (sp.get('view') === 'sent') {
    const stageParam = sp.get('stage')
    const stage = stageParam && stageParam in SENT_STAGE_LABELS ? stageParam as SentStage : null
    return NextResponse.json({ ...(await listSentCards({ q, stage, supplierId: sp.get('supplier') || null, page: Number(sp.get('page')) || 1, pageSize: Number(sp.get('pageSize')) || undefined })), me: viewerFor(user, settings) })
  }
  const [hub, pendingCount, sheets] = await Promise.all([listHandoffHub({ q, supplier: sp.get('supplier') }), countPendingHandoff(), getSheetsConnection()])
  return NextResponse.json({ ...hub, pendingCount, sheetsConnected: sheets.connected && !sheets.needsReconnect, me: viewerFor(user, settings) })
}
