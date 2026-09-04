import { NextRequest, NextResponse } from 'next/server'
import { getParcelPanelApiKey, setParcelPanelApiKey, maskApiKey } from '@/lib/tracking/parcelpanel-config'

// Read/write the ParcelPanel API key from the tool. GET never returns the raw key —
// only whether one is configured and a masked preview.
export async function GET() {
  const key = await getParcelPanelApiKey()
  return NextResponse.json({ configured: !!key, maskedKey: maskApiKey(key) })
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  const apiKey = typeof body?.apiKey === 'string' ? body.apiKey : null
  if (apiKey === null) {
    return NextResponse.json({ error: 'apiKey (string) là bắt buộc.' }, { status: 400 })
  }
  await setParcelPanelApiKey(apiKey)
  const key = await getParcelPanelApiKey()
  return NextResponse.json({ configured: !!key, maskedKey: maskApiKey(key) })
}
