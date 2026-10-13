import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, unauthorized, requireSuperadmin } from '@/lib/api-auth'
import { getDesignSettings, isTrelloMode, saveDesignSettings, TRELLO_MODES, type DesignSettings } from '@/lib/design-settings'

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!user) return unauthorized()
  return NextResponse.json(await getDesignSettings())
}

export async function PUT(req: NextRequest) {
  const auth = await requireSuperadmin(req)
  if ('error' in auth) return auth.error

  const body = await req.json().catch(() => ({} as any))
  const { slaCustomHours, slaNonCustomHours, kpiByType, rejectReasons, designerCanApprove, trelloMode } = body ?? {}

  if (typeof slaCustomHours !== 'number' || slaCustomHours <= 0) {
    return NextResponse.json({ error: 'slaCustomHours must be > 0' }, { status: 400 })
  }
  if (typeof slaNonCustomHours !== 'number' || slaNonCustomHours <= 0) {
    return NextResponse.json({ error: 'slaNonCustomHours must be > 0' }, { status: 400 })
  }
  if (!kpiByType || typeof kpiByType !== 'object' || Array.isArray(kpiByType)) {
    return NextResponse.json({ error: 'kpiByType is required' }, { status: 400 })
  }
  for (const [k, v] of Object.entries(kpiByType as Record<string, unknown>)) {
    if (typeof v !== 'number' || v <= 0) {
      return NextResponse.json({ error: `kpiByType.${k} must be > 0` }, { status: 400 })
    }
  }
  if (!Array.isArray(rejectReasons) || rejectReasons.length === 0 || !rejectReasons.every(r => typeof r === 'string' && r.trim())) {
    return NextResponse.json({ error: 'rejectReasons must be a non-empty array of strings' }, { status: 400 })
  }

  if (designerCanApprove !== undefined && typeof designerCanApprove !== 'boolean') {
    return NextResponse.json({ error: 'designerCanApprove must be a boolean' }, { status: 400 })
  }

  if (trelloMode !== undefined && !isTrelloMode(trelloMode)) {
    return NextResponse.json({ error: `trelloMode must be one of ${TRELLO_MODES.join(', ')}` }, { status: 400 })
  }

  const current = await getDesignSettings()
  const settings: DesignSettings = {
    slaCustomHours, slaNonCustomHours,
    kpiByType: kpiByType as Record<string, number>,
    rejectReasons: rejectReasons as string[],
    designerCanApprove: designerCanApprove ?? current.designerCanApprove,
    trelloMode: trelloMode ?? current.trelloMode,
  }
  await saveDesignSettings(settings)
  return NextResponse.json(settings)
}
