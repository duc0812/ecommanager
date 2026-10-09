import { createClient } from '@libsql/client'
import { randomUUID } from 'crypto'
import path from 'path'

// Moves open design tasks whose every print area already has an AUTO (auto-rendered) artwork to REVIEW,
// exactly like submitAutoRenderForReview in src/lib/design-tasks.ts does after a new render.
// Dry run by default; pass --apply to write. Safe to re-run: moved tasks are REVIEW and no longer match.
const url = process.env.DATABASE_URL?.trim() || `file:${path.resolve(process.cwd(), 'dev.db')}`
const apply = process.argv.includes('--apply')
const db = createClient({ url })

const FROM = ['NEW', 'ASSIGNED', 'DOING', 'REJECTED']
const MESSAGE = 'Tự động gửi duyệt (file in tự động)'
const DEFAULT_PRINT_AREA = 'Artwork'
const now = () => new Date().toISOString().replace('Z', '+00:00')
const all = async (sql, args = []) => (await db.execute({ sql, args })).rows
const one = async (sql, args = []) => (await all(sql, args))[0] ?? null

function parseJson(s, fallback) {
  try { const v = JSON.parse(String(s ?? '')); return v ?? fallback } catch { return fallback }
}

// Mirrors printAreasForLine (src/lib/design-studio.ts).
function printAreasForLine(customAttributesJson) {
  const attrs = parseJson(customAttributesJson, [])
  const pf = Array.isArray(attrs) ? attrs.find(a => a && a.key === '_print_files')?.value : null
  if (typeof pf !== 'string') return [DEFAULT_PRINT_AREA]
  const parsed = parseJson(pf, null)
  if (!Array.isArray(parsed)) return [DEFAULT_PRINT_AREA]
  const names = [...new Set(parsed.map(p => (p && typeof p.print_area === 'string') ? p.print_area.trim() : '').filter(Boolean))]
  return names.length ? names : [DEFAULT_PRINT_AREA]
}

// Mirrors pickTemplate (src/lib/print-template-resolve.ts) with the line's product profile.
async function templateFor(line, storeId) {
  const profile = line.shopifyProductId
    ? await one(`SELECT printTemplateId FROM "ProductProfile" WHERE storeId=? AND shopifyProductId=?`, [storeId, line.shopifyProductId])
    : null
  if (profile?.printTemplateId) {
    const t = await one(`SELECT id, supplierId, supplierSku, areas FROM "PrintTemplate" WHERE id=?`, [profile.printTemplateId])
    if (t && (!line.resolvedSupplierId || t.supplierId === line.resolvedSupplierId)) return t
  }
  if (!line.resolvedSupplierId) return null
  if (line.resolvedSupplierSku) {
    const t = await one(
      `SELECT t.id, t.supplierId, t.supplierSku, t.areas FROM "SupplierProduct" p JOIN "PrintTemplate" t ON t.id = p.printTemplateId WHERE p.supplierId=? AND p.sku=?`,
      [line.resolvedSupplierId, line.resolvedSupplierSku])
    if (t && t.supplierId === line.resolvedSupplierId) return t
  }
  const templates = await all(`SELECT id, supplierId, supplierSku, areas FROM "PrintTemplate" WHERE supplierId=? ORDER BY rowid`, [line.resolvedSupplierId])
  if (!templates.length) return null
  const sku = line.resolvedSupplierSku ? String(line.resolvedSupplierSku).toLowerCase() : null
  let picked = sku ? templates.find(t => t.supplierSku !== null && String(t.supplierSku).toLowerCase() === sku) : undefined
  if (!picked && sku) {
    picked = templates
      .filter(t => t.supplierSku !== null && sku.startsWith(String(t.supplierSku).toLowerCase()))
      .sort((a, b) => String(b.supplierSku).length - String(a.supplierSku).length)[0]
  }
  return picked ?? templates.find(t => t.supplierSku === null) ?? null
}

// Mirrors requiredSlotsFor (src/lib/design-tasks.ts).
async function requiredSlots(line, storeId) {
  const template = await templateFor(line, storeId)
  const areas = template ? parseJson(template.areas, []) : []
  const names = Array.isArray(areas) ? [...new Set(areas.map(a => a?.name).filter(Boolean))] : []
  return names.length ? names : printAreasForLine(line.customAttributesJson)
}

const tasks = await all(
  `SELECT t.id, t.taskKey, t.status, t.readiness, t.orderId, t.shopifyLineId, o.storeId
     FROM "DesignTask" t JOIN "Order" o ON o.id = t.orderId
    WHERE t.status IN (${FROM.map(() => '?').join(',')})
      AND EXISTS (SELECT 1 FROM "DesignArtwork" a WHERE a.orderId = t.orderId AND a.shopifyLineId = t.shopifyLineId AND a.source = 'AUTO' AND a.removedAt IS NULL)
    ORDER BY t.taskKey`, FROM)

const toMove = []
let partial = 0, noLine = 0
for (const t of tasks) {
  const line = await one(
    `SELECT resolvedSupplierId, resolvedSupplierSku, shopifyProductId, customAttributesJson FROM "OrderLine" WHERE orderId=? AND shopifyLineId=?`,
    [t.orderId, t.shopifyLineId])
  if (!line) { noLine++; continue }
  const slots = await requiredSlots(line, t.storeId)
  const autoAreas = new Set((await all(
    `SELECT DISTINCT printArea FROM "DesignArtwork" WHERE orderId=? AND shopifyLineId=? AND source='AUTO' AND removedAt IS NULL`,
    [t.orderId, t.shopifyLineId])).map(r => r.printArea))
  const missing = slots.filter(s => !autoAreas.has(s))
  if (missing.length) { partial++; console.log(`  skip ${t.taskKey} (${t.status}) — chưa có file tự động cho: ${missing.join(', ')}`); continue }
  toMove.push({ ...t, slots })
}

console.log(`openTasksWithAutoArtwork=${tasks.length} toReview=${toMove.length} partial=${partial} lineMissing=${noLine}`)
toMove.forEach(t => console.log(`  -> REVIEW  ${t.taskKey}  ${t.status} -> REVIEW  readiness ${t.readiness} -> AUTO  [${t.slots.join(', ')}]`))

let moved = 0
if (apply) {
  for (const t of toMove) {
    const tx = await db.transaction('write')
    try {
      const at = now()
      const r = await tx.execute({
        sql: `UPDATE "DesignTask" SET status='REVIEW', readiness='AUTO', prevStatus=NULL, updatedAt=? WHERE id=? AND status=?`,
        args: [at, t.id, t.status],
      })
      if (r.rowsAffected === 1) {
        await tx.execute({
          sql: `INSERT INTO "DesignTaskEvent" (id, taskId, type, message, actorId, createdAt) VALUES (?, ?, 'SYSTEM', ?, NULL, ?)`,
          args: [randomUUID(), t.id, MESSAGE, at],
        })
        moved++
      }
      await tx.commit()
    } catch (e) {
      await tx.rollback()
      console.error(`  ! ${t.taskKey}: ${e.message}`)
    } finally {
      tx.close()
    }
  }
}
console.log(apply ? `APPLIED (${moved} moved to REVIEW)` : 'DRY-RUN (pass --apply to write)')
