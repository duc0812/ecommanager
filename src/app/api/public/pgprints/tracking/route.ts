import { NextRequest, NextResponse } from 'next/server'
import { createHash, timingSafeEqual } from 'crypto'
import { pgprintsKeyHolders } from '@/lib/pgprints-settings'
import { applyTrackingWebhook } from '@/lib/repos/pgprints-push'

export const dynamic = 'force-dynamic'

function secretsEqual(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given, 'utf8').digest()
  const b = createHash('sha256').update(expected, 'utf8').digest()
  return timingSafeEqual(a, b)
}

export async function POST(req: NextRequest) {
  const given = req.headers.get('x-store-secret') ?? ''
  const holders = given ? await pgprintsKeyHolders() : []
  // Every key is compared, with no early exit, so the time taken does not say which store's key was close.
  const signed = holders.filter(h => secretsEqual(given, h.settings.secretKey!))
  if (signed.length === 0) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ ok: true, ignored: true, reason: 'invalid body' })
  // The PGprints account id in the body, when the sender gives one, must be the account of a store this key belongs to.
  const accepted = signed.filter(h => typeof body.storeId !== 'string' || !h.settings.storeId || body.storeId === h.settings.storeId)
  if (accepted.length === 0) return NextResponse.json({ ok: true, ignored: true, reason: 'other store' })
  try {
    return NextResponse.json({ ok: true, ...(await applyTrackingWebhook(body, accepted.map(h => h.storeId))) })
  } catch (e) {
    console.error('[pgprints] tracking webhook failed', e)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
