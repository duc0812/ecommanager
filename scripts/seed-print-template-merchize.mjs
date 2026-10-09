import { createClient } from '@libsql/client'
import path from 'path'
import { randomUUID } from 'crypto'

// Area coordinates are the demo's illustrative layout until the real Merchize
// BAJE PSD is measured; replace AREAS once the actual print-area pixel grid is known.
const url = process.env.DATABASE_URL?.trim() || `file:${path.resolve(process.cwd(), 'dev.db')}`
const db = createClient({ url })

const AREAS = [
  { name: 'Front L', x: 220, y: 380, w: 2350, h: 5100 },
  { name: 'Front R', x: 2700, y: 380, w: 2350, h: 5100 },
  { name: 'Back', x: 5250, y: 380, w: 3900, h: 5100 },
  { name: 'Sleeve L', x: 9350, y: 520, w: 1300, h: 2000 },
  { name: 'Sleeve R', x: 10800, y: 520, w: 1300, h: 2000 },
  { name: 'Collar', x: 9350, y: 2900, w: 2750, h: 700 },
]

const supplierRows = (await db.execute({
  sql: `SELECT id, name FROM "Supplier" WHERE code = ? OR name LIKE ? LIMIT 1`,
  args: ['MERCHIZE', '%Merchize%'],
})).rows

const supplier = supplierRows[0]
if (!supplier) {
  console.log('No Merchize supplier in this DB — nothing seeded')
  process.exit(0)
}

const now = new Date().toISOString()

await db.execute({
  sql: `
    INSERT INTO "PrintTemplate" (id, supplierId, supplierSku, name, widthPx, heightPx, dpi, bleedIn, safeIn, mirror, areas, guideImagePath, templateUrl, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(supplierId, supplierSku) DO UPDATE SET
      name = excluded.name,
      widthPx = excluded.widthPx,
      heightPx = excluded.heightPx,
      dpi = excluded.dpi,
      areas = excluded.areas,
      updatedAt = excluded.updatedAt
  `,
  args: [
    randomUUID(),
    supplier.id,
    'BAJE',
    'BAJE AOP Baseball Jersey',
    12289,
    5906,
    150,
    0.125,
    0.2,
    0,
    JSON.stringify(AREAS),
    null,
    'https://drive.google.com/drive/folders/18r2D9XofR5LOLIlQKsce-xzNxweLgOF8',
    now,
    now,
  ],
})

console.log('seeded BAJE for', supplier.name)
