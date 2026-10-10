import { NextRequest, NextResponse } from 'next/server'
import { createHash, timingSafeEqual } from 'crypto'
import { getPgprintsSettings } from '@/lib/pgprints-settings'
import { applyTrackingWebhook } from '@/lib/repos/pgprints-push'

export const dynamic = 'force-dynamic'

function secretsEqual(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given, 'utf8').digest()
  const b = createHash('sha256').update(expected, 'utf8').digest()
  return timingSafeEqual(a, b)
}

export async function POST(req: NextRequest) {
  const settings = await getPgprintsSettings()
  const given = req.headers.get('x-store-secret') ?? ''
  if (!settings.secretKey || !given || !secretsEqual(given, settings.secretKey)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ ok: true, ignored: true, reason: 'invalid body' })
  if (typeof body.storeId === 'string' && settings.storeId && body.storeId !== settings.storeId) {
    return NextResponse.json({ ok: true, ignored: true, reason: 'other store' })
  }
  try {
    return NextResponse.json({ ok: true, ...(await applyTrackingWebhook(body)) })
  } catch (e) {
    console.error('[pgprints] tracking webhook failed', e)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
