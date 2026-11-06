import { NextRequest, NextResponse } from 'next/server'
import { requireSuperadmin } from '@/lib/api-auth'
import { scaleError } from '@/lib/scale/http'
import { saveScaleSettings, scaleSettingsView, type ScaleSettings } from '@/lib/scale/settings'

export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json(await scaleSettingsView())
}

export async function POST(req: NextRequest) {
  const auth = await requireSuperadmin(req)
  if ('error' in auth) return auth.error
  const body = await req.json().catch(() => ({}))
  const patch: Partial<ScaleSettings> = {}
  if (typeof body.imageModel === 'string') patch.imageModel = body.imageModel
  if (typeof body.fallbackModel === 'string') patch.fallbackModel = body.fallbackModel
  if (typeof body.allowFallback === 'boolean') patch.allowFallback = body.allowFallback
  if (typeof body.resolution === 'string') patch.resolution = body.resolution
  if (typeof body.viewAspect === 'string') patch.viewAspect = body.viewAspect
  if (body.visionModel === null || typeof body.visionModel === 'string') patch.visionModel = body.visionModel ? body.visionModel : null
  try {
    await saveScaleSettings(patch)
    return NextResponse.json(await scaleSettingsView())
  } catch (err) { return scaleError(err) }
}
