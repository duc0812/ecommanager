import { createClient } from '@libsql/client'
import path from 'path'

// Export state moved from the order to its lines (OrderLine.exportedAt / exportedToSupplierId). This writes the line
// marks an order-level export implies, exactly like legacyExportedTo in src/lib/line-export.ts:
//   - lines of Order.exportedToSupplierId are marked sent at Order.exportedAt;
//   - lines of another supplier in an EXPORTED order are ALSO marked (we cannot know whether they were sent by hand)
//     and listed under "cần kiểm tra";
//   - orders that already have a line mark, and orders waiting for an export again (READY_TO_PRODUCTION,
//     PENDING_DESIGN, DESIGN_REJECTED, PENDING_MAPPING), are left alone.
// --reopen LIT4628,LIT4528: for those EXPORTED orders, unmark the lines of the other suppliers and move the order back to
// READY_TO_PRODUCTION, so the next export of that supplier picks them up. Runs after the marking, safe to repeat.
// Dry run by default; --apply writes. Database: DATABASE_URL, or a file path argument, else ./dev.db.
const argv = process.argv.slice(2)
const apply = argv.includes('--apply')
const reopenAt = argv.indexOf('--reopen')
const reopenArg = reopenAt >= 0 ? (argv[reopenAt + 1] ?? '') : ''
if (reopenAt >= 0 && (!reopenArg || reopenArg.startsWith('--'))) {
  console.error('--reopen cần danh sách mã đơn, vd --reopen LIT4628,LIT4528')
  process.exit(2)
}
const fileArg = argv.find((a, i) => !a.startsWith('--') && i !== reopenAt + 1)
const url = fileArg
  ? (fileArg.startsWith('file:') || fileArg.startsWith('libsql:') ? fileArg : `file:${path.resolve(process.cwd(), fileArg)}`)
  : process.env.DATABASE_URL?.trim() || `file:${path.resolve(process.cwd(), 'dev.db')}`
const db = createClient({ url })

const PRE_EXPORT_STATUSES = ['READY_TO_PRODUCTION', 'PENDING_DESIGN', 'DESIGN_REJECTED', 'PENDING_MAPPING']
// Mirrors isNonProductLine (src/lib/order-lines.ts).
const DIGITAL = ['custom text']
const ADD_ONS = ['tip', 'shipping protection', 'package protection']
const norm = v => String(v ?? '').toLowerCase().trim()
const isNonProduct = l => DIGITAL.includes(norm(l.shopifyProductType)) || DIGITAL.includes(norm(l.productTitle)) || ADD_ONS.includes(norm(l.productTitle))

const all = async (sql, args = []) => (await db.execute({ sql, args })).rows
const ms = v => {
  if (v === null || v === undefined) return null
  const d = new Date(typeof v === 'bigint' ? Number(v) : v)
  return Number.isNaN(d.getTime()) ? null : d.getTime()
}
const iso = v => (ms(v) === null ? '—' : new Date(ms(v)).toISOString())
const orderNo = s => String(s ?? '').replace(/^#/, '').trim().toUpperCase()

const suppliers = new Map((await all(`SELECT id, name FROM "Supplier"`)).map(s => [s.id, s.name]))
const nameOf = id => (id ? suppliers.get(id) ?? id : '—')

const orders = await all(
  `SELECT id, shopifyOrderNumber, pipelineStatus, fulfillmentStatus, exportedAt, exportedToSupplierId
     FROM "Order" WHERE exportedAt IS NOT NULL ORDER BY placedAt`)
const linesByOrder = new Map()
for (const l of await all(
  `SELECT l.id, l.orderId, l.linePosition, l.sku, l.productTitle, l.shopifyProductType, l.resolvedSupplierId, l.exportedAt, l.exportedToSupplierId
     FROM "OrderLine" l JOIN "Order" o ON o.id = l.orderId WHERE o.exportedAt IS NOT NULL ORDER BY l.linePosition`)) {
  linesByOrder.set(l.orderId, [...(linesByOrder.get(l.orderId) ?? []), l])
}

// Line state after the marking, used by --reopen in a dry run as well.
const state = new Map()
const marks = []
const review = []
let tracked = 0, waiting = 0
for (const o of orders) {
  const lines = linesByOrder.get(o.id) ?? []
  for (const l of lines) state.set(l.id, { exportedAt: l.exportedAt, exportedToSupplierId: l.exportedToSupplierId })
  if (lines.some(l => l.exportedAt !== null && l.exportedAt !== undefined)) { tracked++; continue }
  if (PRE_EXPORT_STATUSES.includes(o.pipelineStatus)) { waiting++; continue }
  for (const l of lines) {
    if (isNonProduct(l) || !l.resolvedSupplierId) continue
    const own = l.resolvedSupplierId === o.exportedToSupplierId
    if (!own && o.pipelineStatus !== 'EXPORTED') continue
    marks.push({ order: o, line: l })
    state.set(l.id, { exportedAt: o.exportedAt, exportedToSupplierId: l.resolvedSupplierId })
    if (!own) review.push({ order: o, line: l })
  }
}

console.log(`ordersWithExportedAt=${orders.length} alreadyTracked=${tracked} waitingForExport=${waiting} linesToMark=${marks.length} canKiemTra=${review.length}`)
for (const m of marks) {
  console.log(`  mark  ${m.order.shopifyOrderNumber} dòng ${m.line.linePosition}  ${nameOf(m.line.resolvedSupplierId)}  at ${iso(m.order.exportedAt)}`)
}
if (review.length) {
  console.log('Cần kiểm tra — đơn EXPORTED có dòng của xưởng khác (đánh dấu đã xuất theo hiện trạng):')
  for (const r of review) {
    console.log(`  ${r.order.shopifyOrderNumber}  dòng ${r.line.linePosition}  ${nameOf(r.line.resolvedSupplierId)}  (đơn xuất cho ${nameOf(r.order.exportedToSupplierId)})  fulfillment ${r.order.fulfillmentStatus ?? 'unfulfilled'}  — ${r.line.productTitle}`)
  }
}

const reopenPlan = []
if (reopenArg) {
  const wanted = Array.from(new Set(reopenArg.split(',').map(orderNo).filter(Boolean)))
  const byNo = new Map(orders.map(o => [orderNo(o.shopifyOrderNumber), o]))
  console.log(`Mở lại (--reopen): ${wanted.join(', ')}`)
  for (const no of wanted) {
    const o = byNo.get(no)
    if (!o) { console.log(`  ${no}: không tìm thấy đơn đã xuất — bỏ qua`); continue }
    // Lines another supplier got only through the order-level export carry the order's export time; anything sent since keeps its mark.
    const lines = (linesByOrder.get(o.id) ?? []).filter(l => {
      const s = state.get(l.id)
      return !isNonProduct(l) && l.resolvedSupplierId && l.resolvedSupplierId !== o.exportedToSupplierId &&
        s.exportedAt !== null && s.exportedAt !== undefined && ms(s.exportedAt) === ms(o.exportedAt) && s.exportedToSupplierId !== o.exportedToSupplierId
    })
    if (lines.length === 0) {
      console.log(`  ${o.shopifyOrderNumber}: không đổi (${o.pipelineStatus}, không còn dòng xưởng khác bị đánh dấu theo lần xuất cũ)`)
      continue
    }
    if (o.pipelineStatus !== 'EXPORTED') {
      console.log(`  ${o.shopifyOrderNumber}: đơn đang ${o.pipelineStatus} — chỉ mở lại đơn EXPORTED, bỏ qua`)
      continue
    }
    reopenPlan.push({ order: o, lines })
    console.log(`  reopen ${o.shopifyOrderNumber}: bỏ đánh dấu ${lines.map(l => `dòng ${l.linePosition} (${nameOf(l.resolvedSupplierId)})`).join(', ')} · EXPORTED -> READY_TO_PRODUCTION`)
  }
}

let marked = 0, reopened = 0, unmarked = 0
if (apply) {
  const byOrder = new Map()
  for (const m of marks) byOrder.set(m.order.id, [...(byOrder.get(m.order.id) ?? []), m])
  for (const list of byOrder.values()) {
    const tx = await db.transaction('write')
    try {
      for (const m of list) {
        const r = await tx.execute({
          sql: `UPDATE "OrderLine" SET exportedAt=?, exportedToSupplierId=? WHERE id=? AND exportedAt IS NULL`,
          args: [m.order.exportedAt, m.line.resolvedSupplierId, m.line.id],
        })
        marked += r.rowsAffected
      }
      await tx.commit()
    } catch (e) {
      await tx.rollback()
      console.error(`  ! ${list[0].order.shopifyOrderNumber}: ${e.message}`)
    } finally {
      tx.close()
    }
  }
  for (const p of reopenPlan) {
    const tx = await db.transaction('write')
    try {
      for (const l of p.lines) {
        const r = await tx.execute({
          sql: `UPDATE "OrderLine" SET exportedAt=NULL, exportedToSupplierId=NULL WHERE id=? AND exportedToSupplierId=?`,
          args: [l.id, l.resolvedSupplierId],
        })
        unmarked += r.rowsAffected
      }
      const r = await tx.execute({
        sql: `UPDATE "Order" SET pipelineStatus='READY_TO_PRODUCTION', updatedAt=? WHERE id=? AND pipelineStatus='EXPORTED'`,
        args: [new Date().toISOString().replace('Z', '+00:00'), p.order.id],
      })
      reopened += r.rowsAffected
      await tx.commit()
    } catch (e) {
      await tx.rollback()
      console.error(`  ! ${p.order.shopifyOrderNumber}: ${e.message}`)
    } finally {
      tx.close()
    }
  }
}
console.log(apply
  ? `APPLIED (${marked} dòng đánh dấu đã xuất, ${unmarked} dòng bỏ đánh dấu, ${reopened} đơn mở lại)`
  : 'DRY-RUN (pass --apply to write)')
