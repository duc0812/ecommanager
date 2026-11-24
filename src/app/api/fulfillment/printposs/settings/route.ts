import { NextRequest, NextResponse } from 'next/server'
import { requireApiAccess, requireSuperadmin } from '@/lib/api-auth'
import { getPrintpossSettings, printpossSettingsView, savePrintpossSettings, type PrintpossSettings } from '@/lib/printposs-settings'
import { printpossId } from '@/lib/printposs-shared'

export async function GET(req: NextRequest) {
  const auth = await requireApiAccess(req)
  if ('error' in auth) return auth.error
  return NextResponse.json(printpossSettingsView(await getPrintpossSettings()))
}

export async function PUT(req: NextRequest) {
  const auth = await requireSuperadmin(req)
  if ('error' in auth) return auth.error
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'Body không hợp lệ' }, { status: 400 })
  const patch: Partial<PrintpossSettings> = {}
  if (body.token !== undefined) {
    if (body.token !== null && (typeof body.token !== 'string' || body.token.length > 4096 || /[\r\n]/.test(body.token))) return NextResponse.json({ error: 'Token không hợp lệ' }, { status: 400 })
    if (body.token === null || body.token.trim()) patch.token = body.token === null ? null : body.token.trim()
  }
  if (body.storeId !== undefined) {
    if (body.storeId !== null && typeof body.storeId !== 'string') return NextResponse.json({ error: 'Store ID phải là chuỗi số' }, { status: 400 })
    if (body.storeId?.trim() && !printpossId(body.storeId)) return NextResponse.json({ error: 'Store ID Printposs phải là số nguyên dương' }, { status: 400 })
    patch.storeId = body.storeId?.trim() || null
  }
  return NextResponse.json(printpossSettingsView(await savePrintpossSettings(patch)))
}
