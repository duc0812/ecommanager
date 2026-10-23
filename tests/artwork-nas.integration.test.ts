import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { claimJob, generateWorkerToken, PARSE_PSD } from '@/lib/artwork-worker'
import { nasProductFolder, nasProductKey, nasSegment, nasSlotFolder } from '@/lib/artwork-nas-paths'
import { listNasSlots } from '@/lib/repos/artwork-nas'
import { GET as getSlots } from '@/app/api/design-studio/worker/nas/slots/route'
import { POST as postReport } from '@/app/api/design-studio/worker/nas/report/route'

const SHOP = 'anas.myshopify.com'
const PROJECT = 'proj_anas'
const SUP = 'sup_anas'
const TPL = 'tpl_anas'
const P1 = 'gid://shopify/Product/9950001'
const TITLE = 'HaPo Wizard 25 Years Of Magic Gifts For Fan Movies - Personalized Tumbler DN2509261948'
const SHA_OLD = 'a'.repeat(64)
const SHA_NEW = 'b'.repeat(64)
const FOLDER = 'Anas/DN2509261948 - HaPo Wizard 25 Years Of Magic Gifts For Fan Movies/20oz Tumbler - Anas Sup UT2-20OZ'

let storeId = ''
let token = ''
let psdFileId = ''

function req(url: string, init?: ConstructorParameters<typeof NextRequest>[1], auth = true) {
  const headers = new Headers(init?.headers)
  if (auth) headers.set('Authorization', `Bearer ${token}`)
  return new NextRequest(url, { ...init, headers })
}
const report = (found: unknown[], missing: string[] = []) => postReport(req('http://x/api/design-studio/worker/nas/report', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ root: '\\\\Tmteam\\Design\\PSD Design', found, missing }),
}))
const item = (over: Record<string, unknown> = {}) => ({
  storeId, shopifyProductId: P1, templateId: TPL, optionKey: '', nasPath: `${FOLDER}/hapo-20oz.psd`, sha256: SHA_NEW, size: 72702308,
  modifiedAt: '2026-10-23T08:00:00.000Z', ...over,
})
const entry = () => prisma.artworkEntry.findUniqueOrThrow({ where: { storeId_shopifyProductId_printTemplateId_optionKey: { storeId, shopifyProductId: P1, printTemplateId: TPL, optionKey: '' } } })

beforeAll(async () => {
  process.env.AUTH_SECRET = 'test-secret-that-is-long-enough-32chars'
  await prisma.project.upsert({ where: { id: PROJECT }, create: { id: PROJECT, name: 'Anas', startDate: new Date('2026-06-01') }, update: {} })
  storeId = (await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: PROJECT }, update: {} })).id
  await prisma.supplier.create({ data: { id: SUP, name: 'Anas Sup', code: 'ANAS' } })
  await prisma.printTemplate.create({ data: {
    id: TPL, supplierId: SUP, supplierSku: 'UT2-20OZ', name: '20oz Tumbler', widthPx: 3270, heightPx: 1860, dpi: 300, areas: JSON.stringify([{ name: 'Print', x: 0, y: 0, w: 3270, h: 1860 }]),
  } })
  await prisma.productProfile.create({ data: { storeId, shopifyProductId: P1, title: TITLE, printTemplateId: TPL } })
  await prisma.order.create({ data: {
    id: 'gid://test/Order/anas-1', projectId: PROJECT, storeId, shopifyOrderNumber: '#ANAS1', financialStatus: 'PAID', currency: 'USD',
    grossAmount: 1, expectedPayout: 1, totalFees: 0, refundedAmount: 0, placedAt: new Date(), pipelineStatus: 'PENDING_DESIGN', orderType: 'CUSTOM',
    lines: { create: [{ shopifyLineId: 'l1', sku: 'DN2509261948-US, 20OZ', productTitle: TITLE, qty: 1, linePosition: 1, unitPrice: 1, shopifyProductId: P1,
      resolvedSupplierId: SUP, resolvedSupplierSku: 'UT2-20OZ', customized: true }] },
  } })
  psdFileId = (await prisma.libraryFile.create({ data: { kind: 'PSD', fileName: 'old.psd', mimeType: 'image/vnd.adobe.photoshop', size: 10, sha256: SHA_OLD, storagePath: 'library/psd/x/old.psd' } })).id
  token = await generateWorkerToken()
})

afterAll(async () => {
  await prisma.order.deleteMany({ where: { storeId } })
  await prisma.artworkEntry.deleteMany({ where: { storeId } })
  await prisma.libraryFile.deleteMany({ where: { id: psdFileId } })
  await prisma.productProfile.deleteMany({ where: { storeId } })
  await prisma.printTemplate.deleteMany({ where: { id: TPL } })
  await prisma.supplier.deleteMany({ where: { id: SUP } })
  await prisma.shopifyStore.deleteMany({ where: { id: storeId } })
  await prisma.project.deleteMany({ where: { id: PROJECT } })
  await prisma.appSetting.deleteMany({ where: { key: 'design.nas.scan' } })
})

describe('NAS folder names', () => {
  it('name the product by its design code and keep Windows-safe, bounded names', () => {
    expect(nasProductKey(TITLE, P1)).toBe('DN2509261948')
    expect(nasProductKey('Gift For Movie Fans DC 2', 'gid://shopify/Product/77')).toBe('P77')
    expect(nasProductFolder(TITLE, P1)).toBe('DN2509261948 - HaPo Wizard 25 Years Of Magic Gifts For Fan Movies')
    expect(nasSegment('a<b>:c"d/e\\f|g?h*  i. ')).toBe('a b c d e f g h i')
    expect(nasSlotFolder({ templateName: 'C450', supplierName: 'Mangoshao', supplierSku: 'C450-30OZ', optionKey: '{"Size":"30oz"}' })).toBe('30oz - Mangoshao C450-30OZ')
  })
})

describe('worker NAS scan', () => {
  it('needs the worker token', async () => {
    expect((await getSlots(req('http://x/api/design-studio/worker/nas/slots', undefined, false))).status).toBe(401)
    expect((await postReport(req('http://x/api/design-studio/worker/nas/report', { method: 'POST', body: '{}' }, false))).status).toBe(401)
  })

  it('lists one folder per product × template slot', async () => {
    const { slots } = await (await getSlots(req('http://x/api/design-studio/worker/nas/slots'))).json()
    const ours = slots.filter((s: any) => s.storeId === storeId)
    expect(ours).toEqual([expect.objectContaining({
      shopifyProductId: P1, templateId: TPL, optionKey: '', productKey: 'DN2509261948', folder: FOLDER.split('/'), entryId: null, nasPath: null,
    })])
  })

  it('a PSD dropped in a new slot creates the entry and queues a parse that reads from the NAS', async () => {
    const res = await (await report([item()])).json()
    expect(res).toMatchObject({ queued: [`${FOLDER}/hapo-20oz.psd`], linked: [], errors: [] })
    const e = await entry()
    expect(e).toMatchObject({ status: 'QUEUED', nasPath: `${FOLDER}/hapo-20oz.psd`, nasSha256: SHA_NEW, nasSize: 72702308, psdFileId: null, title: TITLE })
    const claim: any = await claimJob(new Date(), [PARSE_PSD])
    expect(claim).toMatchObject({ psdFileId: null, psd: { id: null, fileName: 'hapo-20oz.psd', sha256: SHA_NEW, nasPath: `${FOLDER}/hapo-20oz.psd` } })
    await prisma.artworkJob.updateMany({ where: { entryId: e.id }, data: { status: 'DONE' } })
    const scan = await prisma.appSetting.findUniqueOrThrow({ where: { key: 'design.nas.scan' } })
    expect(JSON.parse(scan.value)).toMatchObject({ root: '\\\\Tmteam\\Design\\PSD Design', found: 1, queued: 1 })
  })

  it('the same file again is left alone; once linked, the slot keeps its folder', async () => {
    expect(await (await report([item()])).json()).toMatchObject({ queued: [], linked: [], unchanged: 1 })
    const { slots } = await (await getSlots(req('http://x/api/design-studio/worker/nas/slots'))).json()
    expect(slots.find((s: any) => s.storeId === storeId)).toMatchObject({ nasPath: `${FOLDER}/hapo-20oz.psd`, activeSha256: SHA_NEW })
  })

  it('moving an uploaded PSD to the NAS links it without re-parsing, so tuned fields and the approval stay', async () => {
    await prisma.artworkEntry.update({
      where: { id: (await entry()).id },
      data: { nasPath: null, nasSha256: null, psdFileId, status: 'READY', fields: '[{"field":"Custom Name","sizePx":285}]', approvedAt: new Date() },
    })
    const slotOf = async () => (await (await getSlots(req('http://x/api/design-studio/worker/nas/slots'))).json()).slots.find((s: any) => s.storeId === storeId)
    expect((await slotOf()).pendingUpload).toEqual({ fileId: psdFileId, fileName: 'old.psd', sha256: SHA_OLD, size: 10 })

    const res = await (await report([item({ sha256: SHA_OLD, nasPath: `${FOLDER}/old.psd` })])).json()
    expect(res).toMatchObject({ linked: [`${FOLDER}/old.psd`], queued: [], errors: [] })
    const e = await entry()
    expect(e).toMatchObject({ status: 'READY', nasPath: `${FOLDER}/old.psd`, nasSha256: SHA_OLD, psdFileId: null, fields: '[{"field":"Custom Name","sizePx":285}]' })
    expect(e.approvedAt).not.toBeNull()
    expect(await prisma.artworkJob.count({ where: { entryId: e.id, status: 'QUEUED' } })).toBe(0)
    // the NAS now holds the PSD, so the uploaded copy is gone and nothing is left to pull
    expect(await prisma.libraryFile.findUnique({ where: { id: psdFileId } })).toBeNull()
    expect((await slotOf()).pendingUpload).toBeNull()
  })

  it('an upload still used by another entry is kept until that entry is on the NAS too', async () => {
    const shared = await prisma.libraryFile.create({ data: { kind: 'PSD', fileName: 'shared.psd', mimeType: 'image/vnd.adobe.photoshop', size: 10, sha256: SHA_OLD, storagePath: 'library/psd/x/shared.psd' } })
    const e = await entry()
    await prisma.artworkEntry.update({ where: { id: e.id }, data: { nasPath: null, nasSha256: null, psdFileId: shared.id } })
    const other = await prisma.artworkEntry.create({ data: {
      storeId, shopifyProductId: 'gid://shopify/Product/9950002', printTemplateId: TPL, optionKey: '', supplierId: SUP, title: 'Copy', status: 'READY', psdFileId: shared.id,
    } })
    await report([item({ sha256: SHA_OLD, nasPath: `${FOLDER}/old.psd` })])
    expect(await prisma.libraryFile.findUnique({ where: { id: shared.id } })).not.toBeNull()
    await prisma.artworkEntry.delete({ where: { id: other.id } })
    await prisma.libraryFile.delete({ where: { id: shared.id } })
  })

  it('an edited PSD clears the old result and queues one parse', async () => {
    const res = await (await report([item({ nasPath: `${FOLDER}/old.psd`, sha256: SHA_NEW })])).json()
    expect(res.queued).toEqual([`${FOLDER}/old.psd`])
    const e = await entry()
    expect(e).toMatchObject({ status: 'QUEUED', nasSha256: SHA_NEW, fields: '[]', approvedAt: null })
    expect(await prisma.artworkJob.count({ where: { entryId: e.id, status: 'QUEUED' } })).toBe(1)
  })

  it('refuses paths outside the NAS root, non-PSD files and products without that slot', async () => {
    const res = await (await report([
      item({ nasPath: '../secrets/x.psd' }), item({ nasPath: 'C:/x.psd' }), item({ nasPath: `${FOLDER}/notes.txt` }),
      item({ templateId: 'tpl_missing' }),
    ])).json()
    expect(res.queued).toEqual([])
    expect(res.errors).toHaveLength(4)
  })

  it('lists slots for the library product page too', async () => {
    const slots = await listNasSlots()
    expect(slots.filter(s => s.storeId === storeId)).toHaveLength(1)
  })
})
