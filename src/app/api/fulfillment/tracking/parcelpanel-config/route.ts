import { NextRequest, NextResponse } from 'next/server'
import { getParcelPanelApiKey, setParcelPanelApiKey, maskApiKey } from '@/lib/tracking/parcelpanel-config'
import { requireApiAccess, requireSuperadmin } from '@/lib/api-auth'
import { maskedForSuperadminOnly } from '@/lib/secret-view'

// Read/write the ParcelPanel API key from the tool. GET never returns the raw key —
// only whether one is configured, and a masked preview for a Super Admin.
export async function GET(req: NextRequest) {
  const auth = await requireApiAccess(req)
  if ('error' in auth) return auth.error
  const key = await getParcelPanelApiKey()
  return NextResponse.json(maskedForSuperadminOnly(auth.user, { configured: !!key, maskedKey: maskApiKey(key) }, ['maskedKey']))
}

export async function POST(req: NextRequest) {
  const auth = await requireSuperadmin(req)
  if ('error' in auth) return auth.error
  const body = await req.json().catch(() => null)
  const apiKey = typeof body?.apiKey === 'string' ? body.apiKey : null
  if (apiKey === null) {
    return NextResponse.json({ error: 'apiKey (string) là bắt buộc.' }, { status: 400 })
  }
  await setParcelPanelApiKey(apiKey)
  const key = await getParcelPanelApiKey()
  return NextResponse.json({ configured: !!key, maskedKey: maskApiKey(key) })
}
