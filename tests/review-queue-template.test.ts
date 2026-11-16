import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createClient } from '@libsql/client'
import { parseAreas, pickTemplate, templateView, resolveTemplate, newestSnapshot } from '../scripts/review-queue/template.mjs'

const tpl = (id: string, over: any = {}) => ({
  id, name: `T ${id}`, supplierId: 'sup1', supplierSku: null, widthPx: 1000, heightPx: 500, dpi: 200, bleedIn: 0.125, safeIn: 0.2, mirror: 0,
  areas: '[{"name":"FRONT","x":0,"y":0,"w":500,"h":500},{"name":"BACK","x":500,"y":0,"w":500,"h":500,"shaped":true}]', guideImagePath: null, ...over,
})

describe('parseAreas', () => {
  it('keeps named rectangles with positive sizes, drops the rest', () => {
    expect(parseAreas('[{"name":"A","x":1,"y":2,"w":3,"h":4,"shaped":true},{"name":"","x":0,"y":0,"w":1,"h":1},{"name":"Z","x":0,"y":0,"w":0,"h":1},{"x":1}]'))
      .toEqual([{ name: 'A', x: 1, y: 2, w: 3, h: 4, shaped: true }])
    expect(parseAreas('nope')).toEqual([])
    expect(parseAreas(null)).toEqual([])
  })
})

describe('pickTemplate', () => {
  const line = { supplierId: 'sup1', supplierSku: 'WZIP-L' }
  it('profile template wins when it belongs to the supplier', () => {
    const t = [tpl('p', { supplierId: 'sup1' }), tpl('s', { supplierSku: 'WZIP-L' })]
    expect(pickTemplate(line, { printTemplateId: 'p' }, t, null)?.id).toBe('p')
    expect(pickTemplate(line, { printTemplateId: 'p' }, [tpl('p', { supplierId: 'other' }), t[1]], null)?.id).toBe('s')
  })
  it('then the supplier product, then the exact SKU, then the longest prefix, then the supplier default', () => {
    const t = [tpl('sp', { supplierSku: 'OTHER' }), tpl('exact', { supplierSku: 'WZIP-L' }), tpl('pre', { supplierSku: 'WZIP' }), tpl('pre2', { supplierSku: 'W' }), tpl('def')]
    expect(pickTemplate(line, null, t, { printTemplateId: 'sp' })?.id).toBe('sp')
    expect(pickTemplate(line, null, t, null)?.id).toBe('exact')
    expect(pickTemplate({ supplierId: 'sup1', supplierSku: 'WZIP-XL' }, null, t, null)?.id).toBe('pre')
    expect(pickTemplate({ supplierId: 'sup1', supplierSku: 'KZIP' }, null, t, null)?.id).toBe('def')
    expect(pickTemplate({ supplierId: 'sup1', supplierSku: 'KZIP' }, null, t.slice(0, 4), null)).toBeNull()
    expect(pickTemplate({ supplierId: null, supplierSku: 'WZIP-L' }, null, t, null)).toBeNull()
  })
  it('a variant template is never picked by SKU', () => {
    expect(pickTemplate(line, null, [tpl('v', { supplierSku: 'WZIP-L', variant: 'old' }), tpl('def')], null)?.id).toBe('def')
  })
})

describe('templateView', () => {
  it('maps numbers, parses areas and drops a guide path with a {SIZE} placeholder', () => {
    const v = templateView(tpl('a', { mirror: 1, guideImagePath: 'templates/a/guide-{SIZE}.png', dpi: BigInt(200) }))
    expect(v).toMatchObject({ id: 'a', widthPx: 1000, heightPx: 500, dpi: 200, mirror: true, guideImagePath: null })
    expect(v!.areas).toEqual([{ name: 'FRONT', x: 0, y: 0, w: 500, h: 500, shaped: false }, { name: 'BACK', x: 500, y: 0, w: 500, h: 500, shaped: true }])
    expect(templateView(tpl('b', { guideImagePath: 'templates/b/guide.png' }))!.guideImagePath).toBe('templates/b/guide.png')
    expect(templateView(null)).toBeNull()
  })
})

describe('resolveTemplate on a snapshot', () => {
  let tmp: string
  let db: any
  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rq-tpl-'))
    db = createClient({ url: `file:${path.join(tmp, 'snap.db').replace(/\\/g, '/')}` })
    await db.execute('CREATE TABLE DesignTask (taskKey TEXT, orderId TEXT, shopifyLineId TEXT)')
    await db.execute('CREATE TABLE OrderLine (orderId TEXT, shopifyLineId TEXT, resolvedSupplierId TEXT, resolvedSupplierSku TEXT, shopifyProductId TEXT)')
    await db.execute('CREATE TABLE "Order" (id TEXT, storeId TEXT)')
    await db.execute('CREATE TABLE PrintTemplate (id TEXT, name TEXT, supplierId TEXT, supplierSku TEXT, widthPx INTEGER, heightPx INTEGER, dpi INTEGER, bleedIn REAL, safeIn REAL, mirror INTEGER, areas TEXT, guideImagePath TEXT)')
    await db.execute('CREATE TABLE SupplierProduct (supplierId TEXT, sku TEXT, printTemplateId TEXT)')
    await db.execute('CREATE TABLE ProductProfile (storeId TEXT, shopifyProductId TEXT, printTemplateId TEXT)')
    await db.execute({ sql: 'INSERT INTO DesignTask VALUES (?,?,?)', args: ['LIT1_1', 'o1', 'l1'] })
    await db.execute({ sql: 'INSERT INTO OrderLine VALUES (?,?,?,?,?)', args: ['o1', 'l1', 'sup1', 'WZIP-L', 'gid://shopify/Product/1'] })
    await db.execute({ sql: 'INSERT INTO "Order" VALUES (?,?)', args: ['o1', 'store1'] })
    for (const t of [tpl('exact', { supplierSku: 'WZIP-L', guideImagePath: 'templates/exact/guide.png' }), tpl('def'), tpl('prof', { supplierId: 'sup1' })]) {
      await db.execute({ sql: 'INSERT INTO PrintTemplate VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', args: [t.id, t.name, t.supplierId, t.supplierSku, t.widthPx, t.heightPx, t.dpi, t.bleedIn, t.safeIn, t.mirror, t.areas, t.guideImagePath] })
    }
  })
  // the temp dir stays: libsql still holds the file for a moment after close() and Windows refuses the rm (same as the other queue tests)
  afterEach(() => { db.close() })

  it('finds the exact-SKU template of the line and returns the page view', async () => {
    const v = await resolveTemplate(db, 'LIT1_1')
    expect(v).toMatchObject({ id: 'exact', name: 'T exact', widthPx: 1000, heightPx: 500, guideImagePath: 'templates/exact/guide.png' })
    expect(v!.areas.map((a: any) => a.name)).toEqual(['FRONT', 'BACK'])
  })
  it('a product profile overrides the SKU match', async () => {
    await db.execute({ sql: 'INSERT INTO ProductProfile VALUES (?,?,?)', args: ['store1', 'gid://shopify/Product/1', 'prof'] })
    expect((await resolveTemplate(db, 'LIT1_1'))!.id).toBe('prof')
  })
  it('unknown line, missing tables or no snapshot → null, no throw', async () => {
    expect(await resolveTemplate(db, 'LIT9_1')).toBeNull()
    await db.execute('DROP TABLE PrintTemplate')
    const logs: string[] = []
    expect(await resolveTemplate(db, 'LIT1_1', ((m: string) => { logs.push(m) }) as any)).toBeNull()
    expect(logs).toEqual([])
    expect(await resolveTemplate(null, 'LIT1_1')).toBeNull()
  })
  it('newestSnapshot picks the last prod-snap file by name', () => {
    fs.mkdirSync(path.join(tmp, 'db-backups'))
    for (const n of ['prod-snap-20261116-0100.db', 'prod-snap-20261117-0459.db', 'other.db']) fs.writeFileSync(path.join(tmp, 'db-backups', n), '')
    expect(newestSnapshot(tmp)).toBe(path.join(tmp, 'db-backups', 'prod-snap-20261117-0459.db'))
    expect(newestSnapshot(path.join(tmp, 'nope'))).toBeNull()
  })
})
