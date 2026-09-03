import { createClient } from '@libsql/client'
import path from 'path'

const url = process.env.DATABASE_URL?.trim() || `file:${path.resolve(process.cwd(), 'dev.db')}`
const apply = process.argv.includes('--apply')
const db = createClient({ url })
const parentOf = (sku) => { const s = String(sku ?? '').trim(); const i = s.indexOf('-'); return (i === -1 ? s : s.slice(0, i)).trim() }

const rows = (await db.execute({ sql: `SELECT id, sku, supplierId, parentCode, designLink, ready, designType FROM "SkuSupplierDesign"`, args: [] })).rows

// 1) backfill parentCode where null
let setParent = 0
for (const r of rows) {
  if (!r.parentCode) {
    setParent++
    if (apply) await db.execute({ sql: `UPDATE "SkuSupplierDesign" SET parentCode=? WHERE id=?`, args: [parentOf(r.sku), r.id] })
  }
}

// 2) find duplicate (parentCode, supplierId) groups; keep the ready+link row, else the first
const groups = new Map()
for (const r of rows) {
  const key = `${r.parentCode || parentOf(r.sku)}::${r.supplierId}`
  if (!groups.has(key)) groups.set(key, [])
  groups.get(key).push(r)
}
let dupGroups = 0, toDelete = []
for (const [key, list] of groups) {
  if (list.length < 2) continue
  dupGroups++
  const keep = list.find(x => x.ready && x.designLink) || list[0]
  for (const x of list) if (x.id !== keep.id) toDelete.push({ id: x.id, key })
}

console.log(`rows=${rows.length} setParent=${setParent} dupGroups=${dupGroups} toDelete=${toDelete.length}`)
toDelete.slice(0, 30).forEach(d => console.log('  delete', d.id, 'from', d.key))
if (apply) for (const d of toDelete) await db.execute({ sql: `DELETE FROM "SkuSupplierDesign" WHERE id=?`, args: [d.id] })
console.log(apply ? 'APPLIED' : 'DRY-RUN (pass --apply to write)')
