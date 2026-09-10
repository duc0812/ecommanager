// One-off repair: orders synced before 2026-09-10 stored grossAmount = Shopify
// currentTotalPriceSet (already net of refunds) and then subtracted refundedAmount
// again in expectedPayout. Restore grossAmount to the pre-refund total and recompute
// expectedPayout = grossAmount - totalFees - refundedAmount.
//
// Usage: node scripts/fix-refund-double-count.mjs            (dry run)
//        node scripts/fix-refund-double-count.mjs --apply
import { createClient } from '@libsql/client'

const url = process.env.DATABASE_URL || 'file:./dev.db'
const apply = process.argv.includes('--apply')
const db = createClient({ url })

const rows = await db.execute(
  'SELECT id, shopifyOrderNumber, grossAmount, totalFees, refundedAmount, expectedPayout FROM "Order" WHERE refundedAmount > 0',
)
console.log(`db=${url} orders with refunds: ${rows.rows.length} (${apply ? 'APPLY' : 'dry run'})`)

let changed = 0
for (const r of rows.rows) {
  const gross = Number(r.grossAmount)
  const fees = Number(r.totalFees)
  const refunded = Number(r.refundedAmount)
  const expectedOld = Number(r.expectedPayout)
  const expectedIfAlreadyFixed = gross - fees - refunded
  // Heuristic: rows already repaired (or synced after the fix) satisfy
  // expectedPayout === gross - fees - refunded AND gross >= refunded.
  const alreadyFixed = Math.abs(expectedOld - expectedIfAlreadyFixed) < 0.005 && gross >= refunded - 0.005 && expectedOld >= -0.005
  if (alreadyFixed) continue
  const newGross = Math.round((gross + refunded) * 100) / 100
  const newExpected = Math.round((newGross - fees - refunded) * 100) / 100
  console.log(`${r.shopifyOrderNumber}: gross ${gross} -> ${newGross}, expectedPayout ${expectedOld} -> ${newExpected}`)
  changed++
  if (apply) {
    await db.execute({
      sql: 'UPDATE "Order" SET grossAmount = ?, expectedPayout = ? WHERE id = ?',
      args: [newGross, newExpected, r.id],
    })
  }
}
console.log(`${apply ? 'updated' : 'would update'} ${changed} order(s)`)
