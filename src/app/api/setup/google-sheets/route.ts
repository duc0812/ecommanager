import { NextRequest, NextResponse } from 'next/server'
import { requireSuperadmin } from '@/lib/api-auth'
import { prisma } from '@/lib/db'
import { deleteSettings } from '@/lib/token-store'
import { GOOGLE_KEYS, getGoogleConfig } from '@/lib/google-oauth'
import { SheetsError, getSheetsConnection, listTabs } from '@/lib/google-sheets'
import { SHEET_CHANNELS_KEY, getSheetChannels, tabNameFor, type SheetChannel } from '@/lib/sheet-channel'
import { isCsvLocked, setCsvLocked } from '@/lib/csv-lock'
import jomallChannel from '../../../../../scripts/data/sheet-channel-jomall.json'
import mangoChannel from '../../../../../scripts/data/sheet-channel-mango.json'

export const dynamic = 'force-dynamic'

const KNOWN_CHANNELS = [jomallChannel, mangoChannel] as SheetChannel[]

/** The saved channels, and the known ones not switched on yet. */
async function allChannels(): Promise<SheetChannel[]> {
  const saved = await getSheetChannels()
  return [...saved, ...KNOWN_CHANNELS.filter(k => !saved.some(s => s.supplierCode === k.supplierCode))]
}

async function saveChannels(list: SheetChannel[]) {
  const value = JSON.stringify(list)
  await prisma.appSetting.upsert({ where: { key: SHEET_CHANNELS_KEY }, create: { key: SHEET_CHANNELS_KEY, value }, update: { value } })
}

export async function GET(req: NextRequest) {
  const auth = await requireSuperadmin(req)
  if ('error' in auth) return auth.error
  const [cfg, connection, channels, csvLocked] = await Promise.all([getGoogleConfig(), getSheetsConnection(), allChannels(), isCsvLocked()])
  return NextResponse.json({
    configured: Boolean(cfg.clientId && cfg.clientSecret),
    ...connection,
    csvLocked,
    channels: channels.map(c => ({
      supplierCode: c.supplierCode, enabled: c.enabled, spreadsheetId: c.spreadsheetId, tabPattern: c.tabPattern, storeShop: c.storeShop,
      url: `https://docs.google.com/spreadsheets/d/${c.spreadsheetId}/edit`,
    })),
  })
}

/** { supplierCode, enabled }. Switching on closes that supplier's CSV export, so the sheet must open with this connection first. Or { csvLocked }. */
export async function PUT(req: NextRequest) {
  const auth = await requireSuperadmin(req)
  if ('error' in auth) return auth.error
  const body = await req.json().catch(() => null)
  if (typeof body?.csvLocked === 'boolean') {
    await setCsvLocked(body.csvLocked)
    return NextResponse.json({ ok: true })
  }
  if (!body || typeof body.supplierCode !== 'string' || typeof body.enabled !== 'boolean') {
    return NextResponse.json({ error: 'Cần supplierCode và enabled', code: 'BAD_BODY' }, { status: 400 })
  }
  const channels = await allChannels()
  const channel = channels.find(c => c.supplierCode === body.supplierCode)
  if (!channel) return NextResponse.json({ error: 'Không có kênh của xưởng này', code: 'NOT_FOUND' }, { status: 404 })

  if (body.enabled) {
    const connection = await getSheetsConnection()
    if (!connection.connected || connection.needsReconnect) {
      return NextResponse.json({ error: 'Chưa kết nối Google Sheets — kết nối trước rồi mới bật kênh', code: 'NOT_CONNECTED' }, { status: 409 })
    }
    try {
      const tabs = await listTabs(channel.spreadsheetId)
      const tab = tabNameFor(channel.tabPattern, new Date())
      if (!tabs.includes(tab)) return NextResponse.json({ error: `Sheet chưa có tab "${tab}"`, code: 'NO_TAB' }, { status: 409 })
    } catch (e) {
      if (e instanceof SheetsError) return NextResponse.json({ error: e.message, code: e.code }, { status: 409 })
      throw e
    }
  }
  await saveChannels(channels.map(c => (c.supplierCode === body.supplierCode ? { ...c, enabled: body.enabled } : c)))
  return NextResponse.json({ ok: true })
}

/** Forgets the Sheets connection only; the Drive connection is separate. */
export async function DELETE(req: NextRequest) {
  const auth = await requireSuperadmin(req)
  if ('error' in auth) return auth.error
  if ((await getSheetChannels()).some(c => c.enabled)) {
    return NextResponse.json({ error: 'Còn kênh sheet đang bật — tắt kênh trước rồi mới ngắt kết nối', code: 'CHANNEL_ON' }, { status: 409 })
  }
  await deleteSettings([GOOGLE_KEYS.sheetsRefreshToken, GOOGLE_KEYS.sheetsEmail, GOOGLE_KEYS.sheetsNeedsReconnect])
  global.__sheetsTokenCache = null
  return NextResponse.json({ ok: true })
}
