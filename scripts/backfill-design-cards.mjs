import { createClient } from '@libsql/client'
import path from 'path'

const url = process.env.DATABASE_URL?.trim() || `file:${path.resolve(process.cwd(), 'dev.db')}`
const apply = process.argv.includes('--apply')
const db = createClient({ url })

const cfgRow = await db.execute({ sql: `SELECT value FROM "AppSetting" WHERE key = 'trello.syncFromOrderName'`, args: [] })
const syncFrom = cfgRow.rows[0]?.value ?? ''
const numOf = (s) => parseInt(String(s).replace(/\D/g, ''), 10) || 0
const threshold = numOf(syncFrom)

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

// EXPORTED is skipped too: those orders may already be at the supplier — do not re-queue them for design.
const skipStatuses = new Set(['FULFILLED', 'CANCELLED', 'REFUNDED', 'fulfilled', 'EXPORTED'])
let resettable = 0
const belowThresholdOrders = []
console.log(`Found ${broken.rows.length} broken orders (designReady, no link).`)
console.log(`trello.syncFromOrderName=${syncFrom || '(unset)'} → card-creation threshold=${threshold}`)
for (const o of broken.rows) {
  const isFulfilled = (o.fulfillmentStatus ?? '').toLowerCase() === 'fulfilled'
  const willReset = !skipStatuses.has(o.pipelineStatus) && !isFulfilled
  if (willReset) resettable += 1
  const belowThreshold = numOf(o.shopifyOrderNumber) < threshold
  if (willReset && belowThreshold) belowThresholdOrders.push(o.shopifyOrderNumber)
  console.log(`${o.shopifyOrderNumber} [${o.orderType}/${o.pipelineStatus}] resetToPendingDesign=${willReset} cardOnResync=${!belowThreshold}`)
  if (apply && willReset) {
    await db.execute({
      sql: `UPDATE "Order" SET designReady = 0, designDriveLink = NULL, pipelineStatus = 'PENDING_DESIGN' WHERE id = ?`,
      args: [o.id],
    })
  }
}
console.log(`\n${apply ? 'APPLIED' : 'DRY-RUN'}: ${resettable} orders ${apply ? 'reset' : 'would reset'} to PENDING_DESIGN.`)
if (belowThresholdOrders.length > 0) {
  console.log(`\nWARNING: ${belowThresholdOrders.length} order(s) are below the card-creation threshold (${threshold}).`)
  console.log('These will stay PENDING_DESIGN with NO Trello card until trello.syncFromOrderName is lowered:')
  console.log(`  ${belowThresholdOrders.join(', ')}`)
}
console.log('Next: run the order sync so PENDING_DESIGN orders create Trello cards for un-designed SKUs.')
