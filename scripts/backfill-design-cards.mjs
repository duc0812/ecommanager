import { createClient } from '@libsql/client'
import path from 'path'

const url = process.env.DATABASE_URL?.trim() || `file:${path.resolve(process.cwd(), 'dev.db')}`
const apply = process.argv.includes('--apply')
const db = createClient({ url })

// Broken = designReady but no design link anywhere, with at least one mapped supplier line.
const broken = await db.execute({
  sql: `
    SELECT o.id, o.shopifyOrderNumber, o.orderType, o.pipelineStatus, o.fulfillmentStatus
    FROM "Order" o
    WHERE o.designReady = 1
      AND o.designDriveLink IS NULL
      AND NOT EXISTS (SELECT 1 FROM "OrderLine" l WHERE l.orderId = o.id AND l.designDriveLink IS NOT NULL)
      AND EXISTS (SELECT 1 FROM "OrderLine" l WHERE l.orderId = o.id AND l.resolvedSupplierId IS NOT NULL)
    ORDER BY o.placedAt DESC`,
  args: [],
})

const terminal = new Set(['FULFILLED', 'CANCELLED', 'REFUNDED', 'fulfilled'])
let resettable = 0
console.log(`Found ${broken.rows.length} broken orders (designReady, no link).`)
for (const o of broken.rows) {
  const isFulfilled = (o.fulfillmentStatus ?? '').toLowerCase() === 'fulfilled'
  const willReset = !terminal.has(o.pipelineStatus) && !isFulfilled
  if (willReset) resettable += 1
  console.log(`${o.shopifyOrderNumber} [${o.orderType}/${o.pipelineStatus}] resetToPendingDesign=${willReset}`)
  if (apply && willReset) {
    await db.execute({
      sql: `UPDATE "Order" SET designReady = 0, designDriveLink = NULL, pipelineStatus = 'PENDING_DESIGN' WHERE id = ?`,
      args: [o.id],
    })
  }
}
console.log(`\n${apply ? 'APPLIED' : 'DRY-RUN'}: ${resettable} orders ${apply ? 'reset' : 'would reset'} to PENDING_DESIGN.`)
console.log('Next: run the order sync so PENDING_DESIGN orders create Trello cards for un-designed SKUs.')
