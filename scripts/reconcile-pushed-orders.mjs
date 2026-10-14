import { createClient } from '@libsql/client'
import { randomUUID } from 'crypto'
import path from 'path'

// Orders pushed to PGprints outside the app keep a CREATED SupplierOrderPush with exportMarked = 0. Once such an order is
// READY_TO_PRODUCTION it would be offered for handoff again. This marks it exactly like markPushExported in
// src/lib/repos/push-export.ts: the pushed supplier's lines + order → EXPORTED + API handoff at the push time,
// push → exportMarked + prevExportJson.
// It never calls PGprints. Dry run by default; pass --apply to write. Safe to re-run: marked pushes no longer match.
const url = process.env.DATABASE_URL?.trim() || `file:${path.resolve(process.cwd(), 'dev.db')}`
const apply = process.argv.includes('--apply')
const db = createClient({ url })

const now = () => new Date().toISOString().replace('Z', '+00:00')
const all = async (sql, args = []) => (await db.execute({ sql, args })).rows
const iso = v => {
  if (v === null || v === undefined) return null
  const d = new Date(typeof v === 'bigint' ? Number(v) : v)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

const rows = await all(
  `SELECT p.id AS pushId, p.status, p.supplierId, p.pushedAt, p.pushedById, p.supplierOrderCode, p.externalOrderId,
          o.id AS orderId, o.shopifyOrderNumber, o.pipelineStatus, o.exportedAt, o.exportedToSupplierId,
          o.supplierHandoffAt, o.supplierHandoffMode, o.supplierHandoffById
     FROM "SupplierOrderPush" p JOIN "Order" o ON o.id = p.orderId
    WHERE p.status IN ('SENDING', 'CREATED') AND p.exportMarked = 0 AND o.pipelineStatus = 'READY_TO_PRODUCTION'
    ORDER BY p.createdAt`)

const toMark = rows.filter(r => r.status === 'CREATED')
const unknown = rows.filter(r => r.status !== 'CREATED')

console.log(`readyOrdersWithUnmarkedPush=${rows.length} toMark=${toMark.length} unknownResult=${unknown.length}`)
toMark.forEach(r => console.log(`  -> EXPORTED  ${r.shopifyOrderNumber}  PGprints ${r.supplierOrderCode ?? r.externalOrderId}  pushedAt ${iso(r.pushedAt)}  handoff API`))
unknown.forEach(r => console.log(`  skip ${r.shopifyOrderNumber} — lần gửi ${r.externalOrderId} đang ${r.status} (chưa rõ kết quả): bấm "Cập nhật trạng thái" trong app trước`))

let marked = 0
if (apply) {
  for (const r of toMark) {
    const tx = await db.transaction('write')
    try {
      const at = now()
      const order = await tx.execute({
        sql: `UPDATE "Order"
                 SET pipelineStatus='EXPORTED', exportedAt=?, exportedToSupplierId=?,
                     supplierHandoffAt=?, supplierHandoffMode='API', supplierHandoffById=?, updatedAt=?
               WHERE id=? AND pipelineStatus='READY_TO_PRODUCTION'`,
        args: [r.pushedAt, r.supplierId, r.pushedAt, r.pushedById ?? null, at, r.orderId],
      })
      if (order.rowsAffected === 1) {
        // The pushed supplier's lines carry the push time, which is how a cancel in the app finds them again.
        const lines = await tx.execute({
          sql: `UPDATE "OrderLine" SET exportedAt=?, exportedToSupplierId=? WHERE orderId=? AND resolvedSupplierId=? AND exportedAt IS NULL`,
          args: [r.pushedAt, r.supplierId, r.orderId, r.supplierId],
        })
        const prev = JSON.stringify({
          pipelineStatus: r.pipelineStatus,
          exportedAt: iso(r.exportedAt),
          exportedToSupplierId: r.exportedToSupplierId ?? null,
          supplierHandoffAt: iso(r.supplierHandoffAt),
          supplierHandoffMode: r.supplierHandoffMode ?? null,
          supplierHandoffById: r.supplierHandoffById ?? null,
          linesMarked: lines.rowsAffected,
        })
        const push = await tx.execute({
          sql: `UPDATE "SupplierOrderPush" SET exportMarked=1, prevExportJson=?, updatedAt=? WHERE id=? AND status='CREATED' AND exportMarked=0`,
          args: [prev, at, r.pushId],
        })
        if (push.rowsAffected !== 1) throw new Error('lần gửi vừa đổi trạng thái')
        const code = r.supplierOrderCode ?? r.externalOrderId
        const tasks = (await tx.execute({ sql: `SELECT id FROM "DesignTask" WHERE orderId=? AND status <> 'CANCELLED'`, args: [r.orderId] })).rows
        for (const t of tasks) {
          await tx.execute({
            sql: `INSERT INTO "DesignTaskEvent" (id, taskId, type, message, actorId, createdAt) VALUES (?, ?, 'SYSTEM', ?, NULL, ?)`,
            args: [randomUUID(), t.id, `Đơn đã gửi PGprints từ trước${code ? ` (mã ${code})` : ''} — đánh dấu Exported, không gửi lại`, at],
          })
        }
        marked++
      }
      await tx.commit()
    } catch (e) {
      await tx.rollback()
      console.error(`  ! ${r.shopifyOrderNumber}: ${e.message}`)
    } finally {
      tx.close()
    }
  }
}
console.log(apply ? `APPLIED (${marked} marked EXPORTED)` : 'DRY-RUN (pass --apply to write)')
