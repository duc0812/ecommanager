import fs from 'fs'
import path from 'path'

// Which print template a queued line is checked against, read from the prod snapshot the push used (the page draws every piece
// on that template, like Design Studio's canvas). Same order as src/lib/print-template-resolve.ts pickTemplate: product profile →
// supplier product → exact supplier SKU → longest SKU prefix → the supplier's template without SKU. Prod has no ProductTemplatePin
// table yet, so pins are skipped. Any missing table or column (old snapshot, test fixture) means "no template", never an error.

export const DEFAULT_MAIN_CHECKOUT = 'D:\\Ecom manager\\ecommanager-claude-ecommerce-cashflow-tool-XsLzh'

const num = v => (typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : v == null ? NaN : Number(v))
const str = v => (v == null ? null : String(v))
const errText = e => (e instanceof Error ? e.message : String(e))
const missing = e => /no such (table|column)/i.test(errText(e))

export function parseAreas(json) {
  let parsed
  try { parsed = JSON.parse(json ?? '[]') } catch { return [] }
  if (!Array.isArray(parsed)) return []
  return parsed
    .map(a => ({ name: str(a?.name) ?? '', x: num(a?.x), y: num(a?.y), w: num(a?.w), h: num(a?.h), shaped: a?.shaped === true }))
    .filter(a => a.name && [a.x, a.y, a.w, a.h].every(Number.isFinite) && a.w > 0 && a.h > 0)
}

/** What the page needs; `guideImagePath` stays relative to prod's storage root (`templates/<id>/guide.png`). */
export function templateView(t) {
  if (!t) return null
  const guide = str(t.guideImagePath)
  return {
    id: str(t.id), name: str(t.name) ?? '', supplierId: str(t.supplierId), supplierSku: str(t.supplierSku),
    widthPx: num(t.widthPx), heightPx: num(t.heightPx), dpi: num(t.dpi) || 300,
    bleedIn: Number.isFinite(num(t.bleedIn)) ? num(t.bleedIn) : 0.125, safeIn: Number.isFinite(num(t.safeIn)) ? num(t.safeIn) : 0.2,
    mirror: num(t.mirror) === 1 || t.mirror === true,
    areas: Array.isArray(t.areas) ? t.areas : parseAreas(t.areas),
    guideImagePath: guide && !guide.includes('{') ? guide : null,
  }
}

/**
 * Pure pick. `line` = { supplierId, supplierSku }, `profile` = { printTemplateId } | null, `templates` = every PrintTemplate row of the
 * supplier plus the profile's, `supplierProduct` = { printTemplateId } | null.
 */
export function pickTemplate(line, profile, templates, supplierProduct) {
  const byId = new Map(templates.map(t => [str(t.id), t]))
  if (profile?.printTemplateId) {
    const t = byId.get(str(profile.printTemplateId))
    if (t && (!line.supplierId || str(t.supplierId) === line.supplierId)) return t
  }
  if (!line.supplierId) return null
  if (supplierProduct?.printTemplateId) {
    const t = byId.get(str(supplierProduct.printTemplateId))
    if (t && str(t.supplierId) === line.supplierId) return t
  }
  const own = templates.filter(t => str(t.supplierId) === line.supplierId && (t.variant == null || String(t.variant) === ''))
  if (!own.length) return null
  const sku = line.supplierSku ? line.supplierSku.toLowerCase() : null
  let picked = sku ? own.find(t => t.supplierSku != null && String(t.supplierSku).toLowerCase() === sku) : undefined
  if (!picked && sku) {
    picked = own.filter(t => t.supplierSku != null && sku.startsWith(String(t.supplierSku).toLowerCase()))
      .sort((a, b) => String(b.supplierSku).length - String(a.supplierSku).length)[0]
  }
  if (!picked) picked = own.find(t => t.supplierSku == null)
  return picked ?? null
}

async function rows(snapshot, sql, args) {
  return (await snapshot.execute({ sql, args })).rows
}

const LINE_SQL = `SELECT ol.resolvedSupplierId AS supplierId, ol.resolvedSupplierSku AS supplierSku, ol.shopifyProductId AS productId, o.storeId AS storeId
  FROM DesignTask t
  JOIN OrderLine ol ON ol.orderId = t.orderId AND ol.shopifyLineId = t.shopifyLineId
  LEFT JOIN "Order" o ON o.id = t.orderId
 WHERE t.taskKey = ? LIMIT 1`
const TEMPLATE_COLS = 'id, name, supplierId, supplierSku, widthPx, heightPx, dpi, bleedIn, safeIn, mirror, areas, guideImagePath'

/** The template view of a line, or null. `log` only hears real errors; a snapshot without the tables is silent. */
export async function resolveTemplate(snapshot, taskKey, log = () => {}) {
  if (!snapshot) return null
  try {
    const l = (await rows(snapshot, LINE_SQL, [taskKey]))[0]
    if (!l) return null
    const line = { supplierId: str(l.supplierId), supplierSku: str(l.supplierSku) }
    let profile = null
    if (l.storeId && l.productId) {
      try {
        profile = (await rows(snapshot, 'SELECT printTemplateId FROM ProductProfile WHERE storeId = ? AND shopifyProductId = ? LIMIT 1', [str(l.storeId), str(l.productId)]))[0] ?? null
      } catch (e) { if (!missing(e)) throw e }
    }
    let supplierProduct = null
    if (line.supplierId && line.supplierSku) {
      try {
        supplierProduct = (await rows(snapshot, 'SELECT printTemplateId FROM SupplierProduct WHERE supplierId = ? AND sku = ? AND printTemplateId IS NOT NULL LIMIT 1', [line.supplierId, line.supplierSku]))[0] ?? null
      } catch (e) { if (!missing(e)) throw e }
    }
    const ids = [profile?.printTemplateId, supplierProduct?.printTemplateId].filter(Boolean).map(String)
    const where = ['supplierId = ?', ...ids.map(() => 'id = ?')].join(' OR ')
    const templates = line.supplierId || ids.length
      ? await rows(snapshot, `SELECT ${TEMPLATE_COLS} FROM PrintTemplate WHERE ${where}`, [line.supplierId ?? '', ...ids])
      : []
    return templateView(pickTemplate(line, profile, templates, supplierProduct))
  } catch (e) {
    if (!missing(e)) log(`${taskKey}: không đọc được template từ snapshot: ${errText(e)}`)
    return null
  }
}

/** Newest `db-backups/prod-snap-*.db` of the main checkout, or null. */
export function newestSnapshot(mainCheckout = DEFAULT_MAIN_CHECKOUT) {
  const dir = path.join(mainCheckout, 'db-backups')
  let names
  try { names = fs.readdirSync(dir) } catch { return null }
  const snaps = names.filter(n => /^prod-snap-.*\.db$/.test(n)).sort()
  return snaps.length ? path.join(dir, snaps[snaps.length - 1]) : null
}
