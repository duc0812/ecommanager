import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { AUTH_COOKIE, signToken } from '@/lib/auth'
import { GOOGLE_KEYS } from '@/lib/google-oauth'
import { toRouteKey } from '@/lib/product-profiles'
import { listLibraryProducts, loadLibraryProduct, libraryStateFor } from '@/lib/repos/artwork-library'
import { PUT as uploadPsd } from '@/app/api/design-studio/library/entries/upload/route'
import { PATCH as patchEntry, DELETE as deleteEntryRoute } from '@/app/api/design-studio/library/entries/[id]/route'
import { PUT as uploadFont } from '@/app/api/design-studio/library/fonts/upload/route'
import { GET as getFonts } from '@/app/api/design-studio/library/fonts/route'
import { GET as getFile } from '@/app/api/design-studio/library/files/[id]/route'
import { PUT as putSplit } from '@/app/api/design-studio/library/products/[key]/split/route'
import { buildTtf } from './helpers/font-fixture'

const SHOP = 'alib.myshopify.com'
const PROJECT = 'proj_alib'
const SUP_A = 'sup_alib_a', SUP_B = 'sup_alib_b', SUP_C = 'sup_alib_c'
const TPL_A = 'tpl_alib_a', TPL_OLD = 'tpl_alib_old', TPL_B = 'tpl_alib_b', TPL_X = 'tpl_alib_x'
const P1 = 'gid://shopify/Product/9910001'
const ORDER = 'gid://test/Order/alib-1'
const FONT_NAMES = ['AlibScript-Bold', 'AlibSans-Regular', 'AlibOther-Black']
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alib-storage-'))

let storeId = ''
let editorId = ''
let editorToken = ''
let viewerToken = ''

function psdBytes(extra = 'layers') {
  return Buffer.concat([Buffer.from('8BPS'), Buffer.from([0, 1]), Buffer.from(extra)])
}

function uploadReq(q: Record<string, string>, body: Buffer, token: string | null = editorToken, headers: Record<string, string> = {}) {
  const url = new URL('http://localhost/api/design-studio/library/entries/upload')
  for (const [k, v] of Object.entries(q)) url.searchParams.set(k, v)
  const req = new NextRequest(url, { method: 'PUT', body: new Uint8Array(body), headers })
  if (token) req.cookies.set(AUTH_COOKIE, token)
  return req
}

const target = (templateId: string, fileName = 'design.psd', optionKey?: string) => ({
  storeId, productId: '9910001', templateId, fileName, ...(optionKey !== undefined ? { optionKey } : {}),
})

function splitReq(body: unknown, token = editorToken) {
  const key = toRouteKey(storeId, P1)
  const req = new NextRequest(`http://localhost/api/design-studio/library/products/${key}/split`, { method: 'PUT', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
  req.cookies.set(AUTH_COOKIE, token)
  return putSplit(req, { params: { key } })
}

function patchReq(id: string, body: unknown, token = editorToken) {
  const req = new NextRequest(`http://localhost/api/design-studio/library/entries/${id}`, { method: 'PATCH', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
  req.cookies.set(AUTH_COOKIE, token)
  return req
}

function fontReq(fileName: string, body: Buffer) {
  const req = new NextRequest(`http://localhost/api/design-studio/library/fonts/upload?fileName=${encodeURIComponent(fileName)}`, { method: 'PUT', body: new Uint8Array(body) })
  req.cookies.set(AUTH_COOKIE, editorToken)
  return req
}

function tmpFiles() {
  const dir = path.join(tmp, 'tmp')
  return fs.existsSync(dir) ? fs.readdirSync(dir) : []
}

const FIELD = { field: 'Name', layer: '@Name', sample: 'Anna', font: 'AlibScript-Bold', sizePx: 120, color: '#112233', align: 'center', box: { x: 10, y: 20, w: 300, h: 80 }, anchor: 'center', tracking: 0, fit: 'shrink' }

beforeAll(async () => {
  process.env.AUTH_SECRET = 'test-secret-that-is-long-enough-32chars'
  process.env.DESIGN_STORAGE_DIR = tmp
  await prisma.appSetting.deleteMany({ where: { key: { in: Object.values(GOOGLE_KEYS) } } })
  await prisma.project.upsert({ where: { id: PROJECT }, create: { id: PROJECT, name: 'ALIB Store', startDate: new Date('2026-06-01') }, update: {} })
  storeId = (await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: PROJECT }, update: {} })).id
  await prisma.supplier.createMany({ data: [
    { id: SUP_A, name: 'PGprints', code: 'ALIBA' }, { id: SUP_B, name: 'Mangoshao', code: 'ALIBB' }, { id: SUP_C, name: 'NoTpl', code: 'ALIBC' },
  ] })
  const areas = JSON.stringify([{ name: 'Wrap', x: 0, y: 0, w: 2000, h: 1000 }])
  await prisma.printTemplate.createMany({ data: [
    { id: TPL_A, supplierId: SUP_A, supplierSku: 'TA-SKU', name: 'Tumbler 20oz', widthPx: 2000, heightPx: 1000, areas },
    { id: TPL_OLD, supplierId: SUP_A, supplierSku: 'TOLD-SKU', name: 'Old Tumbler', widthPx: 2000, heightPx: 1000, areas },
    { id: TPL_B, supplierId: SUP_B, supplierSku: 'TB-SKU', name: 'C450-30OZ', widthPx: 2400, heightPx: 1100, areas },
    { id: TPL_X, supplierId: SUP_B, supplierSku: 'TX-SKU', name: 'Unused', widthPx: 100, heightPx: 100, areas },
  ] })
  await prisma.supplierProduct.createMany({ data: [
    { supplierId: SUP_A, sku: 'A-20OZ', baseCost: 3, printTemplateId: TPL_A },
    { supplierId: SUP_B, sku: 'B-30OZ', baseCost: 4, printTemplateId: TPL_B },
    { supplierId: SUP_C, sku: 'C-1', baseCost: 5 },
  ] })
  const line = (id: string, n: number, sup: string | null, sku: string | null, options: Record<string, string>) => ({
    shopifyLineId: id, productTitle: 'ALIB Tumbler', qty: 1, linePosition: n, unitPrice: 1, sku: `SHOP-${n}`, shopifyProductId: P1, customized: true,
    variantOptions: JSON.stringify(options), customAttributesJson: JSON.stringify([{ key: 'Name', value: 'Anna' }, { key: 'Year', value: '2026' }]),
    ...(sup ? { resolvedSupplierId: sup, resolvedSupplierSku: sku, resolvedBaseCost: 1 } : {}),
  })
  await prisma.order.create({ data: {
    id: ORDER, projectId: PROJECT, storeId, shopifyOrderNumber: '#ALIB1', financialStatus: 'PAID', currency: 'USD',
    grossAmount: 1, expectedPayout: 1, totalFees: 0, refundedAmount: 0, placedAt: new Date(Date.now() - 86400_000),
    lines: { create: [
      line('a1', 1, SUP_A, 'A-20OZ', { Size: '20oz(No handle)', Ship: 'US' }),
      line('a2', 2, SUP_A, 'A-20OZ', { Size: '20oz(No handle)', Ship: 'Overseas' }),
      line('b1', 3, SUP_B, 'B-30OZ', { Size: '30oz' }),
      line('c1', 4, SUP_C, 'C-1', { Size: '40oz' }),
      line('u1', 5, null, null, { Size: '20oz(No handle)' }),
    ] },
  } })
  await prisma.artworkEntry.create({ data: { storeId, shopifyProductId: P1, printTemplateId: TPL_A, supplierId: SUP_A, title: 'ALIB Tumbler', status: 'READY' } })
  await prisma.artworkEntry.create({ data: { storeId, shopifyProductId: P1, printTemplateId: TPL_OLD, supplierId: SUP_A, title: 'ALIB Tumbler', status: 'NEEDS_REVIEW' } })

  editorId = (await prisma.appUser.create({ data: { name: 'Lib Editor', email: 'editor@alib.test', role: 'SELLER', permissions: JSON.stringify(['design_tasks']) } })).id
  const viewerId = (await prisma.appUser.create({ data: { name: 'Lib Viewer', email: 'viewer@alib.test', role: 'SELLER', permissions: JSON.stringify(['projects']) } })).id
  editorToken = await signToken({ userId: editorId, email: 'editor@alib.test', name: 'Lib Editor', role: 'SELLER', permissions: ['design_tasks'], tv: 0 })
  viewerToken = await signToken({ userId: viewerId, email: 'viewer@alib.test', name: 'Lib Viewer', role: 'SELLER', permissions: ['projects'], tv: 0 })
})

afterAll(async () => {
  await prisma.artworkEntry.deleteMany({ where: { storeId } })
  await prisma.productProfile.deleteMany({ where: { storeId } })
  await prisma.designFont.deleteMany({ where: { postscriptName: { in: FONT_NAMES } } })
  await prisma.libraryFile.deleteMany({ where: { uploadedById: editorId } })
  await prisma.order.deleteMany({ where: { id: ORDER } })
  await prisma.supplier.deleteMany({ where: { id: { in: [SUP_A, SUP_B, SUP_C] } } })
  await prisma.shopifyStore.deleteMany({ where: { id: storeId } })
  await prisma.project.deleteMany({ where: { id: PROJECT } })
  await prisma.appUser.deleteMany({ where: { email: { in: ['editor@alib.test', 'viewer@alib.test'] } } })
  fs.rmSync(tmp, { recursive: true, force: true })
  delete process.env.DESIGN_STORAGE_DIR
})

describe('library slots from mapping', () => {
  it('groups one product into a slot per template, a no-template slot, unmapped lines and a stale entry', async () => {
    const detail = await loadLibraryProduct(toRouteKey(storeId, P1))
    expect(detail).not.toBeNull()
    const d = detail!
    const bySupplier = (name: string) => d.slots.find(s => s.supplier.name === name)!
    expect(d.slots).toHaveLength(3)
    expect(bySupplier('PGprints')).toMatchObject({
      template: { id: TPL_A, widthPx: 2000, heightPx: 1000, dpi: 300 }, supplierSkus: ['A-20OZ'], lineCount: 2,
      variants: '20oz(No handle) · US, Overseas', title: 'Size: 20oz(No handle) · Ship: Overseas, US', optionKey: '', splitOption: null, status: 'READY',
    })
    expect(bySupplier('PGprints').splitChoices).toEqual([{ name: 'Size', values: ['20oz(No handle)'] }, { name: 'Ship', values: ['Overseas', 'US'] }])
    expect(bySupplier('PGprints').template!.areas).toEqual([{ name: 'Wrap', x: 0, y: 0, w: 2000, h: 1000 }])
    expect(bySupplier('Mangoshao')).toMatchObject({ template: { id: TPL_B }, status: 'EMPTY', entry: null, supplierSkus: ['B-30OZ'] })
    expect(bySupplier('NoTpl')).toMatchObject({ template: null, status: 'NO_TEMPLATE', supplierSkus: ['C-1'], lineCount: 1, title: 'Size: 40oz' })
    expect(d.unmapped).toBe(1)
    expect(d.stale.map(s => s.template.id)).toEqual([TPL_OLD])
    expect(d.stale[0].entry.status).toBe('NEEDS_REVIEW')
    expect(d.status).toBe('NO_MAPPING')
    expect(d.observedFields).toEqual(['Name', 'Year'])
  })

  it('the list shows chips per slot and the worst status', async () => {
    const { products } = await listLibraryProducts({ q: 'alib tumbler' })
    const row = products.find(p => p.storeId === storeId)!
    expect(row.status).toBe('NO_MAPPING')
    expect(row.unmapped).toBe(1)
    expect(row.staleCount).toBe(1)
    expect(row.chips).toEqual(expect.arrayContaining([
      { supplierName: 'PGprints', templateName: 'Tumbler 20oz', supplierSkus: ['A-20OZ'], optionLabel: null, status: 'READY' },
      { supplierName: 'Mangoshao', templateName: 'C450-30OZ', supplierSkus: ['B-30OZ'], optionLabel: null, status: 'EMPTY' },
      { supplierName: 'NoTpl', templateName: null, supplierSkus: ['C-1'], optionLabel: null, status: 'NO_TEMPLATE' },
    ]))
    expect((await listLibraryProducts({ q: 'alib tumbler', status: 'READY' })).products.some(p => p.storeId === storeId)).toBe(false)
  })

  it('the task header state reads the entry for the line template', async () => {
    expect(await libraryStateFor({ storeId, shopifyProductId: P1, templateId: TPL_A })).toMatchObject({ status: 'READY', label: 'Sẵn sàng', optionKey: '', layers: [] })
    expect(await libraryStateFor({ storeId, shopifyProductId: P1, templateId: TPL_B })).toMatchObject({ status: 'NONE', label: 'Thiếu', entryId: null })
  })
})

describe('PUT /api/design-studio/library/entries/upload', () => {
  it('needs a session with design access', async () => {
    expect((await uploadPsd(uploadReq(target(TPL_B), psdBytes(), null))).status).toBe(401)
    expect((await uploadPsd(uploadReq(target(TPL_B), psdBytes(), viewerToken))).status).toBe(403)
  })

  it('rejects a non-PSD name, missing magic bytes, an oversize declaration and a template the product does not use', async () => {
    expect((await uploadPsd(uploadReq(target(TPL_B, 'design.png'), psdBytes()))).status).toBe(400)
    const noMagic = await uploadPsd(uploadReq(target(TPL_B), Buffer.from('PK\x03\x04 zip pretending')))
    expect(noMagic.status).toBe(400)
    expect((await noMagic.json()).error).toMatch(/8BPS/)
    expect((await uploadPsd(uploadReq(target(TPL_B), psdBytes(), editorToken, { 'content-length': String(1024 ** 3 + 1) }))).status).toBe(413)
    expect((await uploadPsd(uploadReq(target(TPL_X), psdBytes()))).status).toBe(400)
    expect(tmpFiles()).toEqual([])
    expect(await prisma.artworkEntry.count({ where: { storeId, printTemplateId: { in: [TPL_B, TPL_X] } } })).toBe(0)
  })

  it('streams the PSD to disk, creates the entry and queues a parse job', async () => {
    const bytes = psdBytes('first version')
    const res = await uploadPsd(uploadReq(target(TPL_B), bytes))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.drive).toBe(false)
    expect(body.entry).toMatchObject({ status: 'QUEUED', printTemplateId: TPL_B, supplierId: SUP_B, fields: [] })
    const entry = await prisma.artworkEntry.findUniqueOrThrow({ where: { id: body.entry.id }, include: { psdFile: true, jobs: true } })
    expect(entry.title).toBe('ALIB Tumbler')
    expect(entry.psdFile).toMatchObject({ kind: 'PSD', storage: 'LOCAL', size: bytes.length, uploadedById: editorId })
    expect(fs.readFileSync(path.join(tmp, entry.psdFile!.storagePath!)).equals(bytes)).toBe(true)
    expect(entry.jobs.map(j => j.status)).toEqual(['QUEUED'])
    expect(tmpFiles()).toEqual([])
  })

  it('a re-upload resets the parse results, keeps the old file and supersedes the open job', async () => {
    const before = await prisma.artworkEntry.findFirstOrThrow({ where: { storeId, printTemplateId: TPL_B } })
    const oldPsd = before.psdFileId!
    const art = await prisma.libraryFile.create({ data: { kind: 'ARTWORK', fileName: 'a.png', mimeType: 'image/png', size: 1, sha256: 'x', uploadedById: editorId } })
    await prisma.artworkEntry.update({ where: { id: before.id }, data: {
      status: 'NEEDS_REVIEW', fields: JSON.stringify([FIELD]), warnings: '["warp"]', checkScore: 9, artworkFileId: art.id, parsedAt: new Date(),
      nasPath: 'Store/P/slot/v1.psd', nasSha256: 'c'.repeat(64), nasSize: 5, nasModifiedAt: new Date(),
    } })
    const res = await uploadPsd(uploadReq(target(TPL_B, 'v2.psd'), psdBytes('second version')))
    expect(res.status).toBe(200)
    const after = await prisma.artworkEntry.findUniqueOrThrow({ where: { id: before.id }, include: { jobs: { orderBy: { createdAt: 'asc' } } } })
    expect(after).toMatchObject({ status: 'QUEUED', fields: '[]', warnings: '[]', checkScore: null, artworkFileId: null, parsedAt: null })
    // the upload is now the PSD in use: the parse reads it, and the next NAS scan copies it over the old NAS file
    expect(after).toMatchObject({ nasPath: null, nasSha256: null, nasSize: null, nasModifiedAt: null })
    expect(after.psdFileId).not.toBe(oldPsd)
    expect(await prisma.libraryFile.count({ where: { id: { in: [oldPsd, art.id] } } })).toBe(2)
    expect(after.jobs.map(j => j.status)).toEqual(['FAILED', 'QUEUED'])
  })

  it('serves the local PSD as an attachment with nosniff', async () => {
    const entry = await prisma.artworkEntry.findFirstOrThrow({ where: { storeId, printTemplateId: TPL_B } })
    const res = await getFile(new NextRequest('http://localhost/x'), { params: { id: entry.psdFileId! } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="v2\.psd"$/)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(Buffer.from(await res.arrayBuffer()).toString('latin1')).toContain('second version')
  })
})

describe('PATCH /api/design-studio/library/entries/[id]', () => {
  it('approves NEEDS_REVIEW only, validates fields and requeues', async () => {
    const entry = await prisma.artworkEntry.findFirstOrThrow({ where: { storeId, printTemplateId: TPL_B } })
    await prisma.artworkEntry.update({ where: { id: entry.id }, data: { status: 'NEEDS_REVIEW', fields: JSON.stringify([FIELD]) } })

    const badFields = await patchEntry(patchReq(entry.id, { fields: [{ ...FIELD, color: 'red' }] }), { params: { id: entry.id } })
    expect(badFields.status).toBe(400)

    const edited = await patchEntry(patchReq(entry.id, { fields: [{ ...FIELD, field: 'Customer Name', fit: 'wrap', maxChars: 12 }], notes: ' ok ' }), { params: { id: entry.id } })
    expect(edited.status).toBe(200)
    expect((await edited.json()).entry).toMatchObject({ notes: 'ok', fields: [{ field: 'Customer Name', fit: 'wrap', maxChars: 12 }] })

    const ok = await patchEntry(patchReq(entry.id, { approve: true }), { params: { id: entry.id } })
    expect(ok.status).toBe(200)
    expect((await ok.json()).entry).toMatchObject({ status: 'READY', approvedByName: 'Lib Editor' })
    expect((await patchEntry(patchReq(entry.id, { approve: true }), { params: { id: entry.id } })).status).toBe(400)

    const re = await patchEntry(patchReq(entry.id, { reparse: true }), { params: { id: entry.id } })
    expect((await re.json()).entry).toMatchObject({ status: 'QUEUED', fields: [{ field: 'Customer Name' }] })
    expect(await prisma.artworkJob.count({ where: { entryId: entry.id, status: 'QUEUED' } })).toBe(1)
  })

  it('only admins delete entries', async () => {
    const entry = await prisma.artworkEntry.findFirstOrThrow({ where: { storeId, printTemplateId: TPL_OLD } })
    const req = new NextRequest(`http://localhost/x`, { method: 'DELETE' })
    req.cookies.set(AUTH_COOKIE, editorToken)
    expect((await deleteEntryRoute(req, { params: { id: entry.id } })).status).toBe(403)
  })
})

describe('PUT /api/design-studio/library/fonts/upload', () => {
  it('rejects non-font files', async () => {
    expect((await uploadFont(fontReq('x.woff', Buffer.from('wOFF')))).status).toBe(400)
    expect((await uploadFont(fontReq('x.ttf', Buffer.from('not a font at all, really')))).status).toBe(400)
    expect(tmpFiles()).toEqual([])
  })

  it('stores the font by postscript name and requeues entries that only waited for it', async () => {
    const waiting = await prisma.artworkEntry.findFirstOrThrow({ where: { storeId, printTemplateId: TPL_A, optionKey: '' } })
    const stillWaiting = await prisma.artworkEntry.findFirstOrThrow({ where: { storeId, printTemplateId: TPL_OLD } })
    const psd = await prisma.libraryFile.create({ data: { kind: 'PSD', fileName: 'p.psd', mimeType: 'image/vnd.adobe.photoshop', size: 1, sha256: 'p', uploadedById: editorId } })
    await prisma.artworkEntry.update({ where: { id: waiting.id }, data: { status: 'NEEDS_FONTS', psdFileId: psd.id, missingFonts: JSON.stringify(['AlibScript-Bold']) } })
    await prisma.artworkEntry.update({ where: { id: stillWaiting.id }, data: { status: 'NEEDS_FONTS', psdFileId: psd.id, missingFonts: JSON.stringify(['AlibScript-Bold', 'AlibOther-Black']) } })

    const res = await uploadFont(fontReq('Alib Script Bold.ttf', buildTtf({ 1: 'Alib Script', 2: 'Bold', 6: 'AlibScript-Bold' })))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.fonts).toEqual([expect.objectContaining({ postscriptName: 'AlibScript-Bold', family: 'Alib Script', style: 'Bold' })])
    expect(body.requeued).toBe(1)
    expect((await prisma.artworkEntry.findUniqueOrThrow({ where: { id: waiting.id } })).status).toBe('QUEUED')
    expect(await prisma.artworkJob.count({ where: { entryId: waiting.id, status: 'QUEUED' } })).toBe(1)
    expect((await prisma.artworkEntry.findUniqueOrThrow({ where: { id: stillWaiting.id } })).status).toBe('NEEDS_FONTS')

    await prisma.artworkEntry.update({ where: { id: waiting.id }, data: { fields: JSON.stringify([FIELD]) } })
    const list = await (await getFonts()).json()
    expect(list.fonts.find((f: any) => f.postscriptName === 'AlibScript-Bold')).toMatchObject({ family: 'Alib Script', usedBy: 2 })
  })
})

describe('artwork per option', () => {
  const US = '{"Ship":"US"}'
  const OVERSEAS = '{"Ship":"Overseas"}'

  it('rejects a split by an option the template lines do not have, or for a template the product does not use', async () => {
    const bad = await splitReq({ printTemplateId: TPL_A, optionName: 'Color' })
    expect(bad.status).toBe(400)
    expect((await bad.json()).error).toMatch(/Color/)
    expect((await splitReq({ printTemplateId: TPL_X, optionName: 'Size' })).status).toBe(400)
    expect((await splitReq({ printTemplateId: TPL_A, optionName: '' })).status).toBe(400)
    expect(await prisma.productProfile.count({ where: { storeId } })).toBe(0)
  })

  it('"Tách theo option" creates the profile on demand and turns the template slot into one slot per value', async () => {
    const res = await splitReq({ printTemplateId: TPL_A, optionName: 'Ship' })
    expect(res.status).toBe(200)
    const d = await res.json()
    const slots = d.slots.filter((s: any) => s.template?.id === TPL_A)
    expect(slots.map((s: any) => [s.optionKey, s.title, s.splitOption, s.inherited])).toEqual([
      [OVERSEAS, 'Size: 20oz(No handle) · Ship: Overseas', 'Ship', true],
      [US, 'Size: 20oz(No handle) · Ship: US', 'Ship', true],
    ])
    const shared = await prisma.artworkEntry.findFirstOrThrow({ where: { storeId, printTemplateId: TPL_A, optionKey: '' } })
    expect(slots.every((s: any) => s.entry.id === shared.id)).toBe(true)
    const profile = await prisma.productProfile.findFirstOrThrow({ where: { storeId, shopifyProductId: P1 } })
    expect(JSON.parse(profile.artworkSplits)).toEqual([{ printTemplateId: TPL_A, optionName: 'Ship' }])
    expect(profile.title).toBe('ALIB Tumbler')
  })

  it('upload validates the optionKey against the product slots', async () => {
    expect((await uploadPsd(uploadReq(target(TPL_A, 'us.psd', 'not json'), psdBytes()))).status).toBe(400)
    expect((await uploadPsd(uploadReq(target(TPL_A, 'us.psd', '{ "Ship": "US" }'), psdBytes()))).status).toBe(400)
    const eu = await uploadPsd(uploadReq(target(TPL_A, 'eu.psd', '{"Ship":"EU"}'), psdBytes()))
    expect(eu.status).toBe(400)
    expect((await eu.json()).error).toMatch(/Ship: EU/)
    expect((await uploadPsd(uploadReq(target(TPL_B, 'b.psd', US), psdBytes()))).status).toBe(400)
    expect(tmpFiles()).toEqual([])
  })

  it('upload with an optionKey creates an entry for that value only, and lines resolve to it before the "" entry', async () => {
    const res = await uploadPsd(uploadReq(target(TPL_A, 'us.psd', US), psdBytes('us only')))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.entry).toMatchObject({ printTemplateId: TPL_A, optionKey: US, optionLabel: 'Ship: US', status: 'QUEUED' })
    const shared = await prisma.artworkEntry.findFirstOrThrow({ where: { storeId, printTemplateId: TPL_A, optionKey: '' } })
    expect(body.entry.id).not.toBe(shared.id)

    const us = await libraryStateFor({ storeId, shopifyProductId: P1, templateId: TPL_A, variantOptions: JSON.stringify({ Size: '20oz(No handle)', Ship: 'US' }) })
    expect(us).toMatchObject({ entryId: body.entry.id, optionKey: US, optionLabel: 'Ship: US', label: 'Đang đọc' })
    const overseas = await libraryStateFor({ storeId, shopifyProductId: P1, templateId: TPL_A, variantOptions: JSON.stringify({ Ship: 'Overseas' }) })
    expect(overseas).toMatchObject({ entryId: shared.id, optionKey: '' })

    const patched = await patchEntry(patchReq(body.entry.id, { notes: 'US artwork' }), { params: { id: body.entry.id } })
    expect((await patched.json()).entry).toMatchObject({ optionKey: US, notes: 'US artwork' })

    const d = (await loadLibraryProduct(toRouteKey(storeId, P1)))!
    const slot = (k: string) => d.slots.find(s => s.template?.id === TPL_A && s.optionKey === k)!
    expect(slot(US)).toMatchObject({ inherited: false, entry: { id: body.entry.id } })
    expect(slot(OVERSEAS)).toMatchObject({ inherited: true, entry: { id: shared.id } })
    expect((await listLibraryProducts({ q: 'alib tumbler' })).products.find(p => p.storeId === storeId)!.chips
      .filter(c => c.templateName === 'Tumbler 20oz').map(c => c.optionLabel)).toEqual(['Ship: Overseas', 'Ship: US'])
  })

  it('"Gộp lại" undoes the split; the per-value entry stays valid under stale and lines fall back to ""', async () => {
    const res = await splitReq({ printTemplateId: TPL_A, optionName: null })
    expect(res.status).toBe(200)
    const d = await res.json()
    expect(d.slots.filter((s: any) => s.template?.id === TPL_A).map((s: any) => s.optionKey)).toEqual([''])
    expect(d.stale.map((s: any) => s.entry.optionKey)).toContain(US)
    const us = await libraryStateFor({ storeId, shopifyProductId: P1, templateId: TPL_A, variantOptions: { Ship: 'US' } })
    expect(us?.optionKey).toBe('')
    expect(await prisma.artworkEntry.count({ where: { storeId, printTemplateId: TPL_A, optionKey: US } })).toBe(1)
  })
})
