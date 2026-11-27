import { NextRequest, NextResponse } from 'next/server'
import { requireSuperadmin } from '@/lib/api-auth'
import { prisma } from '@/lib/db'
import { readFactoryOrderRows } from '@/lib/google-sheets'
import { enabledChannelFor, getSheetChannels } from '@/lib/sheet-channel'
import { MoveLineError, moveUnsentLine } from '@/lib/repos/line-move-supplier'

export const dynamic = 'force-dynamic'
const allowedTargets = new Set(['BZA170-M', 'FZH9-L-ONESIZE', 'BZA226-ONESIZE'])
const normalize = (s: string | undefined) => (s ?? '').replace(/^#/, '').trim().toUpperCase()

export async function POST(req: NextRequest) {
  const admin = await requireSuperadmin(req)
  if ('error' in admin) return admin.error
  const body = await req.json().catch(() => null)
  if (!body || !['check','apply'].includes(body.action) || !Array.isArray(body.lines) || !body.lines.length || body.lines.length > 100 ||
      typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 500) {
    return NextResponse.json({ error: 'Cần lý do và danh sách 1–100 dòng' }, { status: 400 })
  }
  type Entry = { key: string; sourceSku: string; targetSku: string; sheetRow: number }
  const entries: Entry[] = body.lines
  if (entries.some(e => !e || !/^[A-Z0-9-]+_\d+$/.test(e.key) || typeof e.sourceSku !== 'string' || !e.sourceSku ||
      !allowedTargets.has(e.targetSku) || !Number.isSafeInteger(e.sheetRow) || e.sheetRow < 0 || e.sheetRow === 1) ||
      new Set(entries.map(e => e.key)).size !== entries.length) {
    return NextResponse.json({ error: 'Mã dòng, SKU, số dòng sheet hoặc danh sách trùng không hợp lệ' }, { status: 400 })
  }
  const source = await prisma.supplier.findUnique({ where: { code: 'litzzy_inhouse' }, select: { id: true, code: true } })
  const channel = source && enabledChannelFor(await getSheetChannels(), source)
  if (!source || !channel || channel.tabPattern !== 'ORDER') return NextResponse.json({ error: 'Chưa xác định được sheet ORDER của Litzzy Inhouse' }, { status: 409 })
  const targets = await prisma.supplierProduct.findMany({ where: { supplier: { code: 'toaddit', isActive: true }, sku: { in: Array.from(allowedTargets) } }, select: { id: true, sku: true } })
  let rows: Awaited<ReturnType<typeof readFactoryOrderRows>>
  try { rows = await readFactoryOrderRows(channel.spreadsheetId, channel.tabPattern) } catch {
    return NextResponse.json({ error: 'Không đọc được trạng thái và màu đánh dấu trên sheet xưởng' }, { status: 409 })
  }
  const header = rows[0]?.values
  if (header?.[1] !== 'Order Number' || header[2] !== 'Order Vendor' || header[9] !== 'Status' || header[15] !== 'Tracking') {
    return NextResponse.json({ error: 'Cột trạng thái hoặc tracking trên sheet đã đổi' }, { status: 409 })
  }
  const results = []
  for (const entry of entries) {
    try {
      const order = entry.key.split('_')[0]
      const matching = rows.map((row, index) => ({ ...row, number: index + 1 })).filter(row => {
        const ids = [normalize(row.values[1]), normalize(row.values[2])]
        return ids.includes(entry.key) || (ids.includes(order) && !ids.some(id => /_\d+$/.test(id)))
      })
      if (matching.some(row => row.marked || row.values[9] || row.values[15])) throw new MoveLineError('Sheet có dấu, trạng thái hoặc tracking')
      if (matching.length !== (entry.sheetRow ? 1 : 0) || (entry.sheetRow && matching[0]?.number !== entry.sheetRow)) throw new MoveLineError('Dòng sheet đã thay đổi, cần đối chiếu lại')
      const target = targets.find(p => p.sku === entry.targetSku)
      if (!target) throw new MoveLineError('SKU ToAddit chưa sẵn sàng')
      const result = await moveUnsentLine(entry.key, { supplierProductId: target.id, reason: body.reason }, admin.user, {
        sourceId: source.id, sourceSku: entry.sourceSku, dryRun: body.action === 'check', sheetRow: entry.sheetRow || null,
        spreadsheetId: channel.spreadsheetId, tab: channel.tabPattern,
      })
      results.push({ key: entry.key, ok: true, sku: entry.targetSku, ...result })
    } catch (e) {
      results.push({ key: entry.key, ok: false, error: e instanceof MoveLineError ? e.message : 'Lỗi xử lý dòng, kiểm tra lại trạng thái' })
    }
  }
  return NextResponse.json({ results })
}
