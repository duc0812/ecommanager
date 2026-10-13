import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { POST as exportRoute } from '@/app/api/fulfillment/export/route'
import { findPublicArtwork } from '@/lib/public-artwork'
import { renderCsv } from '@/lib/csv-template'

const SHOP = 'export-links.myshopify.com'
const PROJECT = 'proj_export_links'
const SUP = 'sup_export_links'
const BASE = 'https://app.shop-tool.com'
const savedAppUrl = process.env.NEXT_PUBLIC_APP_URL
let storeId = ''
let templateId = ''
let seq = 0

const COLUMNS = [
  { header: 'Order', source: 'order.shopifyOrderNumber' },
  { header: 'Design', source: 'line.designDriveLink' },
  { header: 'All', source: 'line.designLinks' },
  { header: 'Front', source: 'line.designArea:Front' },
  { header: 'Back', source: 'line.designArea:back' },
]

type Art = { area: string; version?: number; drive?: string | null; removed?: boolean }

async function makeOrder(opts: { link?: string | null; arts?: Art[]; printAreas?: string[]; task?: string | null; status?: string; orderLink?: string | null }) {
  seq += 1
  const id = `gid://test/Order/export-links-${seq}`
  const number = `#EXL${seq}`
  const attrs = opts.printAreas
    ? JSON.stringify([{ key: '_print_files', value: JSON.stringify(opts.printAreas.map(a => ({ print_area: a, url: 'https://cdn.example/src.png' }))) }])
    : null
  await prisma.order.create({ data: {
    id, projectId: PROJECT, storeId, shopifyOrderNumber: number, financialStatus: 'PAID', currency: 'USD',
    grossAmount: 1, expectedPayout: 1, totalFees: 0, refundedAmount: 0, placedAt: new Date('2026-10-05T10:00:00Z'),
    pipelineStatus: opts.status ?? 'READY_TO_PRODUCTION', designReady: true, designDriveLink: opts.orderLink ?? null, defaultSupplierId: SUP,
    lines: { create: [{ shopifyLineId: 'l1', sku: `EXL-${seq}`, productTitle: 'Jersey', qty: 1, linePosition: 1, unitPrice: 10,
      resolvedSupplierId: SUP, resolvedSupplierSku: 'EXL-SKU', customAttributesJson: attrs }] },
  } })
  const ids: string[] = []
  for (const a of opts.arts ?? []) {
    const row = await prisma.designArtwork.create({ data: {
      orderId: id, shopifyLineId: 'l1', printArea: a.area, version: a.version ?? 1, fileName: `${a.area.toLowerCase()}-v${a.version ?? 1}.png`,
      storagePath: a.drive ? null : `x/${seq}-${a.area}.png`, storage: a.drive ? 'DRIVE' : 'LOCAL', driveFileId: a.drive ? `f-${seq}-${a.area}` : null,
      driveWebViewLink: a.drive ?? null, size: 1, mimeType: 'image/png', removedAt: a.removed ? new Date() : null,
    } })
    ids.push(row.id)
  }
  const link = opts.link === undefined ? (ids[0] ? `/api/design-studio/file/${ids[0]}` : null) : opts.link
  await prisma.orderLine.updateMany({ where: { orderId: id }, data: { designDriveLink: link } })
  if (opts.task !== null) {
    await prisma.designTask.create({ data: { orderId: id, shopifyLineId: 'l1', taskKey: `${number.slice(1)}_1`, status: opts.task ?? 'DONE' } })
  }
  return { id, number, artworkIds: ids }
}

async function run(extra: Record<string, unknown> = {}) {
  const res = await exportRoute(new NextRequest('http://x/api/fulfillment/export', {
    method: 'POST', body: JSON.stringify({ templateId, preview: true, ...extra }),
  }))
  return { status: res.status, body: await res.json() }
}

function rowsOf(csv: string): Record<string, Record<string, string>> {
  const [head, ...rest] = csv.split('\n').map(r => r.split(','))
  return Object.fromEntries(rest.map(r => [r[0], Object.fromEntries(head.map((h, i) => [h, r[i] ?? '']))]))
}

beforeAll(async () => {
  await prisma.project.upsert({ where: { id: PROJECT }, create: { id: PROJECT, name: 'Export links', startDate: new Date('2026-06-01') }, update: {} })
  storeId = (await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: PROJECT }, update: {} })).id
  await prisma.supplier.upsert({ where: { code: 'EXLSUP' }, create: { id: SUP, name: 'Export Links Supplier', code: 'EXLSUP' }, update: {} })
  templateId = (await prisma.csvTemplate.create({ data: { supplierId: SUP, name: 'links', rowMode: 'PER_LINE', columns: JSON.stringify(COLUMNS) } })).id
})

beforeEach(async () => {
  process.env.NEXT_PUBLIC_APP_URL = BASE
  await prisma.order.deleteMany({ where: { storeId } })
})

afterAll(async () => {
  await prisma.order.deleteMany({ where: { storeId } })
  await prisma.supplier.deleteMany({ where: { id: SUP } })
  if (savedAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL
  else process.env.NEXT_PUBLIC_APP_URL = savedAppUrl
})

describe('supplier CSV design links', () => {
  it('a LOCAL artwork becomes a public URL the public route serves, never the app path', async () => {
    const o = await makeOrder({ arts: [{ area: 'Artwork' }] })
    const { status, body } = await run()
    expect(status).toBe(200)
    const row = rowsOf(body.csv)[o.number]
    expect(row.Design).toMatch(new RegExp(`^${BASE}/api/public/artwork/[0-9a-f]{64}/artwork-v1\\.png$`))
    expect(row.All).toBe(row.Design)
    expect(body.csv).not.toContain('/api/design-studio/file/')
    expect((await prisma.orderLine.findFirstOrThrow({ where: { orderId: o.id } })).designDriveLink).toBe(`/api/design-studio/file/${o.artworkIds[0]}`)

    const [, , , , token, fileName] = new URL(row.Design).pathname.split('/')
    expect((await findPublicArtwork(token, fileName))?.id).toBe(o.artworkIds[0])
  })

  it('a Drive artwork exports its Drive link', async () => {
    const drive = 'https://drive.google.com/file/d/exl-drive/view'
    const o = await makeOrder({ arts: [{ area: 'Artwork', drive }], link: drive })
    const row = rowsOf((await run()).body.csv)[o.number]
    expect(row.Design).toBe(drive)
    expect((await prisma.designArtwork.findUniqueOrThrow({ where: { id: o.artworkIds[0] } })).publicToken).toBeNull()
  })

  it('joins the newest file of every required area with " | " and fills the per-area sources', async () => {
    const back = 'https://drive.google.com/file/d/exl-back/view'
    const o = await makeOrder({
      printAreas: ['Front', 'Back'],
      arts: [{ area: 'Front', version: 1 }, { area: 'Front', version: 2 }, { area: 'Back', drive: back }, { area: 'Sleeve' }],
    })
    const { status, body } = await run()
    expect(status).toBe(200)
    const row = rowsOf(body.csv)[o.number]
    const [front, second] = row.Design.split(' | ')
    expect(front).toMatch(/front-v2\.png$/)
    expect(second).toBe(back)
    expect(row.All).toBe(row.Design)
    expect(row.Front).toBe(front)
    expect(row.Back).toBe(back)
    expect(row.Design).not.toContain('sleeve')
  })

  it('leaves Trello, library and manual links untouched, even when the line also has Studio files', async () => {
    const trello = 'https://drive.google.com/file/d/from-trello/view'
    const plain = await makeOrder({ link: trello, task: null })
    const mixed = await makeOrder({ link: trello, arts: [{ area: 'Artwork' }] })
    const rows = rowsOf((await run()).body.csv)
    expect(rows[plain.number]).toMatchObject({ Design: trello, All: trello, Front: '', Back: '' })
    expect(rows[mixed.number].Design).toBe(trello)
  })

  it.each(['http://localhost:3002', ''])('400 listing the orders when NEXT_PUBLIC_APP_URL is %j and a LOCAL link is needed', async (value) => {
    if (value) process.env.NEXT_PUBLIC_APP_URL = value
    else delete process.env.NEXT_PUBLIC_APP_URL
    const local = await makeOrder({ arts: [{ area: 'Artwork' }] })
    const drive = await makeOrder({ arts: [{ area: 'Artwork', drive: 'https://drive.google.com/file/d/ok/view' }], link: 'https://drive.google.com/file/d/ok/view' })
    const { status, body } = await run({ markExported: true })
    expect(status).toBe(400)
    expect(body.orders).toEqual([local.number])
    expect(body.error).toContain(local.number)
    expect(body.error).not.toContain(drive.number)
    expect(body.error).toContain('NEXT_PUBLIC_APP_URL')
    expect(body.csv).toBeUndefined()
    expect((await prisma.order.findUniqueOrThrow({ where: { id: local.id } })).pipelineStatus).toBe('READY_TO_PRODUCTION')
    expect((await prisma.designArtwork.findUniqueOrThrow({ where: { id: local.artworkIds[0] } })).publicToken).toBeNull()
  })

  it('a bad base URL does not block an export that needs no LOCAL link', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3002'
    const drive = 'https://drive.google.com/file/d/only-drive/view'
    const o = await makeOrder({ arts: [{ area: 'Artwork', drive }], link: drive })
    const { status, body } = await run()
    expect(status).toBe(200)
    expect(rowsOf(body.csv)[o.number].Design).toBe(drive)
  })

  it('400 for a LOCAL file whose line is not approved — the public route would refuse it', async () => {
    const o = await makeOrder({ arts: [{ area: 'Artwork' }], task: 'REJECTED', status: 'DESIGN_REJECTED' })
    const { status, body } = await run()
    expect(status).toBe(400)
    expect(body.orders).toEqual([o.number])
    expect(body.error).toContain('chưa được duyệt')
  })

  it('400 when the stored app link points at a removed file', async () => {
    const o = await makeOrder({ arts: [{ area: 'Artwork', removed: true }] })
    const { status, body } = await run()
    expect(status).toBe(400)
    expect(body.orders).toEqual([o.number])
  })

  it('a template without a design column exports whatever the base URL is', async () => {
    delete process.env.NEXT_PUBLIC_APP_URL
    const o = await makeOrder({ arts: [{ area: 'Artwork' }] })
    const plain = await prisma.csvTemplate.create({ data: { supplierId: SUP, name: 'plain', rowMode: 'PER_LINE', columns: JSON.stringify([COLUMNS[0]]) } })
    const { status, body } = await run({ templateId: plain.id })
    expect(status).toBe(200)
    expect(body.csv).toContain(o.number)
  })
})

describe('renderCsv design sources', () => {
  const order = {
    shopifyOrderNumber: '#1', customerName: null, customerEmail: null, shippingCountry: null, shippingState: null, placedAt: new Date('2026-10-01'),
    lines: [{ sku: 'A', supplierSku: 'S', qty: 1, productTitle: 'T', variantTitle: null, designLinks: 'u1 | u2', designAreaLinks: { Front: 'u1', 'Left Sleeve': 'u2' } }],
  }
  it('reads one area by name, case-insensitively, and is empty for an unknown area or a per-order row', () => {
    const cols = ['line.designLinks', 'line.designArea:Front', 'line.designArea:left sleeve', 'line.designArea:Back', 'line.designArea:']
    const csv = renderCsv({ rowMode: 'PER_LINE', columns: cols.map((source, i) => ({ header: `c${i}`, source })) }, [order])
    expect(csv.split('\n')[1]).toBe('u1 | u2,u1,u2,,')
    expect(renderCsv({ rowMode: 'PER_ORDER', columns: [{ header: 'a', source: 'line.designArea:Front' }] }, [order]).split('\n')[1]).toBe('')
  })
})
