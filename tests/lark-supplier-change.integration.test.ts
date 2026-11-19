import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { prisma } from '@/lib/db'
import { syncDesignTasks } from '@/lib/design-tasks'
import { agentTaskState, type AgentTaskState } from '@/lib/design-agent/delivery'
import { profileKey, parseProfileOverrides } from '@/lib/product-mapping'
import type { Llm } from '@/lib/llm/types'
import type { AcceptedLarkMessage } from '@/lib/lark/events'
import type { LarkIntent } from '@/lib/lark/intent'
import { processLarkMessage } from '@/lib/lark/process'
import { changeSupplierFromLark, undoSupplierFromLark } from '@/lib/lark/supplier-change'
import { agentFixture } from './helpers/design-agent-fixture'
import { dropWorkBoard, publishBoard } from './helpers/work-board'

const fx = agentFixture('lsc')
const NEW_CODE = 'LSCNEW'
const NEW_NAME = 'LSC Xưởng Mới'
const OLD_SKU = 'OLD-SKU'
const M = { Type: 'Hoodie', Size: 'M' }
const L = { Type: 'Hoodie', Size: 'L' }

let newSupplierId = ''
let pinnedTemplateId = ''
const sp: Record<string, string> = {}

type LineSpec = { product: string | null; options: Record<string, string> | null }

async function order(n: number, lines: LineSpec[], opts: { otherStore?: boolean } = {}) {
  const orderId = `gid://test/Order/lsc-${n}`
  await prisma.order.create({
    data: {
      id: orderId, projectId: opts.otherStore ? 'proj2_lsc' : 'proj_lsc', storeId: opts.otherStore ? fx.otherStoreId : fx.storeId,
      shopifyOrderNumber: `#LSC${n}`, financialStatus: 'PAID', currency: 'USD',
      grossAmount: 1, expectedPayout: 1, totalFees: 0, refundedAmount: 0, placedAt: new Date('2026-11-01'),
      pipelineStatus: 'PENDING_DESIGN', orderType: 'CUSTOM',
      lines: { create: lines.map((l, i) => ({
        shopifyLineId: `l${i + 1}`, sku: 'DN1-Hoodie', productTitle: 'Hoodie', shopifyProductType: 'LscType', qty: 1, linePosition: i + 1, unitPrice: 1,
        shopifyProductId: l.product, variantOptions: l.options ? JSON.stringify(l.options) : null,
        resolvedSupplierId: fx.supplierId, resolvedSupplierSku: OLD_SKU, resolvedBaseCost: 5, customized: true,
        customAttributesJson: JSON.stringify([{ key: 'Name', value: 'X' }]),
      })) },
    },
  })
  await syncDesignTasks(orderId)
  return orderId
}

const lineOf = (n: number, i = 1) => prisma.orderLine.findFirstOrThrow({ where: { orderId: `gid://test/Order/lsc-${n}`, shopifyLineId: `l${i}` } })
const taskOf = async (key: string): Promise<AgentTaskState> => (await agentTaskState(key))!
const profileOf = (product: string, storeId = fx.storeId) => prisma.productProfile.findUnique({ where: { storeId_shopifyProductId: { storeId, shopifyProductId: product } } })
const changesOf = (key: string) => prisma.botMappingChange.findMany({ where: { taskKey: key }, orderBy: { createdAt: 'asc' } })
const allChanges = () => prisma.botMappingChange.count({ where: { taskKey: { startsWith: 'LSC' } } })
const change = async (key: string, over: Partial<{ supplierName: string; supplierSku: string; instruction: string }> = {}) =>
  changeSupplierFromLark({ task: await taskOf(key), supplierName: NEW_NAME, supplierSku: 'NEW-HD-M', instruction: '', sender: 'Lan', ...over })
const undo = async (key: string) => undoSupplierFromLark({ task: await taskOf(key), sender: 'Lan' })
async function eventsOf(key: string) {
  const t = await prisma.designTask.findUniqueOrThrow({ where: { taskKey: key } })
  return (await prisma.designTaskEvent.findMany({ where: { taskId: t.id } })).map(e => e.message)
}
const print = (n: number, data: { removedAt?: Date; createdAt?: Date; kind?: string } = {}) => prisma.designArtwork.create({
  data: { orderId: `gid://test/Order/lsc-${n}`, shopifyLineId: 'l1', kind: data.kind ?? 'PRINT', printArea: 'PRINT', version: data.removedAt ? 1 : 2, fileName: 'a.png', storagePath: `x/lsc-${n}.png`, size: 1, mimeType: 'image/png', removedAt: data.removedAt, createdAt: data.createdAt },
})
async function expectUntouched(n: number, i = 1) {
  expect(await lineOf(n, i)).toMatchObject({ resolvedSupplierId: fx.supplierId, resolvedSupplierSku: OLD_SKU, resolvedBaseCost: 5 })
}

async function cleanup() {
  await prisma.botMappingChange.deleteMany({ where: { taskKey: { startsWith: 'LSC' } } })
  await prisma.larkEvent.deleteMany({ where: { eventId: { startsWith: 'lsc-' } } })
  await fx.cleanup()
  await prisma.supplier.deleteMany({ where: { code: { in: [NEW_CODE, 'LSCTWIN1', 'LSCTWIN2'] } } })
}

beforeAll(async () => {
  await cleanup()
  await fx.seed()
  await publishBoard()
  newSupplierId = (await prisma.supplier.create({ data: { name: NEW_NAME, code: NEW_CODE } })).id
  const twin = await prisma.supplier.create({ data: { name: 'LSC Twin', code: 'LSCTWIN1' } })
  await prisma.supplier.create({ data: { name: 'lsc twin', code: 'LSCTWIN2' } })
  const tpl = (name: string, supplierSku: string | null) => prisma.printTemplate.create({ data: { supplierId: newSupplierId, supplierSku, name, widthPx: 100, heightPx: 100, areas: '[]' } })
  const direct = await tpl('LSC Hoodie M', 'ANOTHER-KEY')
  pinnedTemplateId = (await tpl('LSC Hoodie L', 'new-hd-l')).id
  const fallback = await tpl('LSC mặc định', null)
  await tpl('LSC ColTee', 'COL-M-RED')
  const foreign = await prisma.printTemplate.create({ data: { supplierId: twin.id, supplierSku: 'TW-1', name: 'Twin riêng', widthPx: 100, heightPx: 100, areas: '[]' } })
  const product = async (sku: string, extra: { printTemplateId?: string; productName?: string; variant1Name?: string; variant1Value?: string; variant2Name?: string; variant2Value?: string } = {}) => {
    sp[sku] = (await prisma.supplierProduct.create({ data: { supplierId: newSupplierId, sku, baseCost: 7, ...extra, productName: extra.productName ?? 'Hoodie' } })).id
  }
  await product('NEW-HD-M', { printTemplateId: direct.id })
  await product('NEW-HD-L')
  await product('NEW-NOTPL', { productName: 'Mug' })
  for (let i = 1; i <= 7; i++) await product(`AMB-${i}`, { productName: 'Tee amb' })
  await product('NEW-DEF', { printTemplateId: fallback.id })
  await product('NEW-OTHER', { printTemplateId: foreign.id })
  await product('COL-M-RED', { productName: 'ColTee', variant1Name: 'Size', variant1Value: 'M', variant2Name: 'Color', variant2Value: 'Red' })
  await product('WB-9', { productName: 'Windbreaker jacket' })

  await order(1, [{ product: 'P1', options: M }, { product: 'P1', options: L }])
  await order(2, [{ product: 'P1', options: { Size: 'M', Type: 'Hoodie' } }])
  await order(3, [{ product: 'P1', options: M }], { otherStore: true })
  await order(4, [{ product: 'P1', options: M }])
  await prisma.order.update({ where: { id: 'gid://test/Order/lsc-4' }, data: { pipelineStatus: 'FULFILLED' } })
  await order(10, [{ product: 'PEXP', options: M }])
  await order(11, [{ product: 'PEXP', options: M }])
  await order(12, [{ product: 'PPRINT', options: M }])
  await order(13, [{ product: 'PPRINT', options: M }])
  await order(14, [{ product: 'PSTREAM', options: M }])
  await order(15, [{ product: 'PSTREAM', options: M }])
  await order(16, [{ product: 'PMISC', options: M }])
  await order(17, [{ product: 'PEMPTY', options: null }])
  await order(18, [{ product: 'PUNDO', options: M }])
  await order(19, [{ product: 'PUNDO', options: M }])
  await order(20, [{ product: 'PUNDO2', options: M }])
  await order(21, [{ product: 'PUNDO2', options: M }])
  await order(22, [{ product: 'PUNDO3', options: M }])
  await order(23, [{ product: 'PBOT', options: L }])
  await order(24, [{ product: 'PNOTASK', options: M }])
  await order(25, [{ product: 'PNOTASK', options: M }])
  await order(26, [{ product: 'PPIN', options: M }])
  await order(27, [{ product: 'PPINTPL', options: M }])
  await order(28, [{ product: 'PCOL', options: { Size: 'M', Color: 'Blue' } }])
  await order(29, [{ product: 'PUNDO4', options: M }])
  await order(30, [{ product: 'PUNDO4', options: M }])
  await order(31, [{ product: 'PUNDO5', options: M }])
  await order(32, [{ product: 'PUNDO6', options: M }])
})

afterAll(async () => {
  await cleanup()
  await dropWorkBoard()
})

describe('supplier change from Lark', () => {
  it('changes only the named combo', async () => {
    const r = await change('LSC1_1', { supplierName: 'lsc xuong moi' })
    expect(r).toEqual({ changed: true, reply: 'LSC1_1: đã chuyển sang LSC Xưởng Mới, SKU NEW-HD-M, template LSC Hoodie M. Đã đổi 2 dòng cùng biến thể.' })
    expect(await lineOf(1)).toMatchObject({ resolvedSupplierId: newSupplierId, resolvedSupplierSku: 'NEW-HD-M', resolvedBaseCost: 7 })
    const profile = await profileOf('P1')
    expect(parseProfileOverrides(profile!.overrides)).toEqual([{ combo: M, supplierProductId: sp['NEW-HD-M'] }])
    expect(profile!.supplierProductId).toBeNull()
    const [row] = await changesOf('LSC1_1')
    expect(row).toMatchObject({ profileKey: profileKey(fx.storeId, 'P1'), beforeOverridesJson: '[]', afterSupplierProductId: sp['NEW-HD-M'], requestedBy: 'Lan', undoneAt: null })
    expect(JSON.parse(row.comboJson)).toEqual(M)
    const snapshot = JSON.parse(row.lineSnapshotJson)
    expect(snapshot).toHaveLength(2)
    expect(snapshot[0]).toMatchObject({ resolvedSupplierId: fx.supplierId, resolvedSupplierSku: OLD_SKU, resolvedBaseCost: 5 })
    expect(await eventsOf('LSC1_1')).toContain('Chuyển xưởng theo yêu cầu của Lan trên Lark: LSC Supplier sang LSC Xưởng Mới (NEW-HD-M)')
    expect((await prisma.designTask.findUniqueOrThrow({ where: { taskKey: 'LSC1_1' } })).supplierSnapshot).toBe(NEW_NAME)
  })

  it('other variant of the product untouched', async () => {
    await expectUntouched(1, 2)
    expect(await eventsOf('LSC1_2')).not.toContain('Chuyển xưởng theo yêu cầu của Lan trên Lark: LSC Supplier sang LSC Xưởng Mới (NEW-HD-M)')
  })

  it('sibling in another order moves too', async () => {
    expect(await lineOf(2)).toMatchObject({ resolvedSupplierId: newSupplierId, resolvedSupplierSku: 'NEW-HD-M', resolvedBaseCost: 7 })
    expect(await eventsOf('LSC2_1')).toContain('Chuyển xưởng theo yêu cầu của Lan trên Lark: LSC Supplier sang LSC Xưởng Mới (NEW-HD-M)')
  })

  it('same variant in another store or in a frozen order stays', async () => {
    await expectUntouched(3)
    await expectUntouched(4)
    expect(await profileOf('P1', fx.otherStoreId)).toBeNull()
  })

  it('a second change replaces the override of that combo and keeps the others', async () => {
    const r = await change('LSC1_2', { supplierSku: 'new-hd-l' })
    expect(r.reply).toBe('LSC1_2: đã chuyển sang LSC Xưởng Mới, SKU NEW-HD-L, template LSC Hoodie L. Đã đổi 1 dòng cùng biến thể.')
    const again = await change('LSC1_2', { supplierSku: 'NEW-HD-M' })
    expect(again.changed).toBe(true)
    expect(parseProfileOverrides((await profileOf('P1'))!.overrides)).toEqual([
      { combo: L, supplierProductId: sp['NEW-HD-M'] }, { combo: M, supplierProductId: sp['NEW-HD-M'] },
    ])
    expect(await lineOf(1, 2)).toMatchObject({ resolvedSupplierId: newSupplierId, resolvedSupplierSku: 'NEW-HD-M' })
  })

  it('exported sibling refuses and names it', async () => {
    await prisma.orderLine.updateMany({ where: { orderId: 'gid://test/Order/lsc-11' }, data: { exportedAt: new Date('2026-11-02') } })
    const r = await change('LSC10_1')
    expect(r.changed).toBe(false)
    expect(r.reply).toBe('LSC10_1: không chuyển được — dòng LSC11_1 cùng biến thể đã xuất xưởng.')
    await expectUntouched(10)
    await expectUntouched(11)
    expect(await profileOf('PEXP')).toBeNull()
    expect(await changesOf('LSC10_1')).toHaveLength(0)
  })

  it('sibling with a live print refuses', async () => {
    await print(12, { removedAt: new Date('2026-11-03') })
    await print(12, { kind: 'MOCKUP' })
    await print(13)
    const r = await change('LSC12_1')
    expect(r.changed).toBe(false)
    expect(r.reply).toBe('LSC12_1: không chuyển được — dòng LSC13_1 cùng biến thể đang có file in. Gỡ file in của xưởng cũ trên tool rồi nhắn lại.')
    await expectUntouched(12)
    expect(await profileOf('PPRINT')).toBeNull()
    expect(await changesOf('LSC12_1')).toHaveLength(0)
  })

  it('line held by a stream refuses', async () => {
    await publishBoard([{ taskKey: 'LSC15_1', source: 'STREAM', worker: 'Luồng 7', state: 'doing' }])
    const r = await change('LSC14_1')
    await publishBoard()
    expect(r.changed).toBe(false)
    expect(r.reply).toBe('LSC14_1: không chuyển được vì dòng cùng biến thể chưa rảnh — LSC15_1: Luồng 7 đang giữ dòng này.')
    await expectUntouched(14)
    await expectUntouched(15)
    expect(await profileOf('PSTREAM')).toBeNull()
  })

  it('stale board refuses', async () => {
    await dropWorkBoard()
    const r = await change('LSC16_1')
    await publishBoard()
    expect(r.changed).toBe(false)
    expect(r.reply).toBe('LSC16_1: không chuyển được vì dòng cùng biến thể chưa rảnh — LSC16_1: chưa xác định được ai đang giữ vì dữ liệu từ máy local chưa cập nhật.')
    await expectUntouched(16)
    expect(await profileOf('PMISC')).toBeNull()
  })

  it('default null-SKU template does not count', async () => {
    const r = await change('LSC16_1', { supplierSku: 'NEW-NOTPL' })
    expect(r.changed).toBe(false)
    expect(r.reply).toBe('LSC16_1: SKU NEW-NOTPL của LSC Xưởng Mới chưa có template in riêng (template mặc định của xưởng không được tính). Hãy tạo template cho SKU này trên tool rồi nhắn lại.')
    await expectUntouched(16)
    expect(await profileOf('PMISC')).toBeNull()
  })

  it('ambiguous SKU lists at most 5 and writes nothing', async () => {
    const r = await change('LSC16_1', { supplierSku: 'AMB' })
    expect(r.changed).toBe(false)
    expect(r.reply).toBe('LSC16_1: chưa xác định được sản phẩm của LSC Xưởng Mới. Hãy ghi đúng SKU xưởng. Gợi ý: AMB-1, AMB-2, AMB-3, AMB-4, AMB-5')
    const byWords = await change('LSC16_1', { supplierSku: '', instruction: 'chuyển sang áo tee amb' })
    expect(byWords.reply).toBe(r.reply)
    await expectUntouched(16)
    expect(await profileOf('PMISC')).toBeNull()
    expect(await changesOf('LSC16_1')).toHaveLength(0)
  })

  it('no supplier, an unknown supplier and a name two suppliers share all refuse', async () => {
    expect((await change('LSC16_1', { supplierName: ' ' })).reply).toBe('LSC16_1: chưa rõ chuyển sang xưởng nào. Hãy ghi tên xưởng và SKU, ví dụ: LSC16_1 chuyển sang Merchize SKU ABC.')
    expect((await change('LSC16_1', { supplierName: 'Không Có Xưởng Này' })).reply).toBe('LSC16_1: không tìm thấy xưởng "Không Có Xưởng Này".')
    expect((await change('LSC16_1', { supplierName: 'LSC TWIN' })).reply).toBe('LSC16_1: "LSC TWIN" khớp nhiều xưởng: LSC Twin (LSCTWIN1), lsc twin (LSCTWIN2). Hãy ghi rõ tên hoặc mã xưởng.')
    await expectUntouched(16)
    expect(await profileOf('PMISC')).toBeNull()
  })

  it('a product named by instruction words alone is taken when exactly one fits', async () => {
    const r = await change('LSC26_1', { supplierSku: '', instruction: 'chuyển sang cái mug' })
    expect(r.reply).toContain('SKU NEW-NOTPL của LSC Xưởng Mới chưa có template in riêng')
  })

  it('empty variant options refuses', async () => {
    const r = await change('LSC17_1')
    expect(r.changed).toBe(false)
    expect(r.reply).toBe('LSC17_1: dòng này không có thông tin biến thể nên không chuyển riêng được. Hãy đổi mapping của sản phẩm trên tool.')
    await expectUntouched(17)
    expect(await profileOf('PEMPTY')).toBeNull()
  })

  it('a sibling without a design task passes the holder check', async () => {
    await prisma.designTask.deleteMany({ where: { orderId: 'gid://test/Order/lsc-25' } })
    const r = await change('LSC24_1')
    expect(r.reply).toBe('LSC24_1: đã chuyển sang LSC Xưởng Mới, SKU NEW-HD-M, template LSC Hoodie M. Đã đổi 2 dòng cùng biến thể.')
    expect(await lineOf(25)).toMatchObject({ resolvedSupplierId: newSupplierId, resolvedSupplierSku: 'NEW-HD-M' })
  })

  it('a line pinned by hand refuses, because the profile would not move it', async () => {
    await prisma.orderLine.updateMany({ where: { orderId: 'gid://test/Order/lsc-26' }, data: { productionOverrideJson: JSON.stringify({ version: 1, supplierProductId: sp['NEW-HD-L'], supplierSku: 'NEW-HD-L', supplierId: newSupplierId, variantTitle: 'M', variantOptions: M, source: 'manual', history: [] }) } })
    const r = await change('LSC26_1')
    expect(r.changed).toBe(false)
    expect(r.reply).toBe('LSC26_1: không chuyển được — dòng LSC26_1 đang được chỉnh xưởng riêng trên tool (không theo mapping sản phẩm). Hãy đổi xưởng của dòng đó trên tool.')
    await expectUntouched(26)
    expect(await profileOf('PPIN')).toBeNull()
  })

  it('undo restores overrides and lines', async () => {
    const before = JSON.stringify([{ combo: { Size: 'XL' }, supplierProductId: sp['NEW-HD-L'] }])
    await prisma.productProfile.create({ data: { storeId: fx.storeId, shopifyProductId: 'PUNDO', title: 'Hoodie', overrides: before } })
    expect((await undo('LSC18_1'))).toEqual({ changed: false, reply: 'LSC18_1: chưa có lần chuyển xưởng nào qua Lark để hoàn tác.' })
    expect((await change('LSC18_1')).changed).toBe(true)
    expect(await lineOf(19)).toMatchObject({ resolvedSupplierId: newSupplierId })
    expect(parseProfileOverrides((await profileOf('PUNDO'))!.overrides)).toHaveLength(2)

    const r = await undo('LSC18_1')
    expect(r).toEqual({ changed: true, reply: 'LSC18_1: đã hoàn tác, trả về LSC Supplier, SKU OLD-SKU. Đã đổi lại 2 dòng cùng biến thể.' })
    await expectUntouched(18)
    await expectUntouched(19)
    expect((await profileOf('PUNDO'))!.overrides).toBe(before)
    expect((await changesOf('LSC18_1'))[0].undoneAt).toBeInstanceOf(Date)
    expect((await prisma.designTask.findUniqueOrThrow({ where: { taskKey: 'LSC19_1' } })).supplierSnapshot).toBe('LSC Supplier')
    expect(await eventsOf('LSC18_1')).toContain('Hoàn tác chuyển xưởng theo yêu cầu của Lan trên Lark: LSC Xưởng Mới về LSC Supplier (OLD-SKU)')
    expect((await undo('LSC18_1')).changed).toBe(false)
  })

  it('undo keeps an override somebody else added to the profile meanwhile', async () => {
    await prisma.productProfile.deleteMany({ where: { shopifyProductId: 'PUNDO3' } })
    expect((await change('LSC22_1')).changed).toBe(true)
    const other = { combo: { Size: '3XL' }, supplierProductId: sp['NEW-HD-L'] }
    const profile = (await profileOf('PUNDO3'))!
    await prisma.productProfile.update({ where: { id: profile.id }, data: { overrides: JSON.stringify([...parseProfileOverrides(profile.overrides), other]) } })
    expect((await undo('LSC22_1')).changed).toBe(true)
    expect(parseProfileOverrides((await profileOf('PUNDO3'))!.overrides)).toEqual([other])
    await expectUntouched(22)
  })

  it('undo refuses after an export', async () => {
    expect((await change('LSC20_1')).changed).toBe(true)
    await prisma.orderLine.updateMany({ where: { orderId: 'gid://test/Order/lsc-21' }, data: { exportedAt: new Date() } })
    const r = await undo('LSC20_1')
    expect(r).toEqual({ changed: false, reply: 'LSC20_1: không hoàn tác được — dòng LSC21_1 đã xuất xưởng sau lần chuyển.' })
    expect(await lineOf(20)).toMatchObject({ resolvedSupplierId: newSupplierId, resolvedSupplierSku: 'NEW-HD-M' })
    expect(parseProfileOverrides((await profileOf('PUNDO2'))!.overrides)).toHaveLength(1)
    expect((await changesOf('LSC20_1'))[0].undoneAt).toBeNull()
  })

  it('undo refuses once a print was made after the change', async () => {
    expect((await change('LSC22_1')).changed).toBe(true)
    await print(22, { createdAt: new Date(Date.now() + 60_000) })
    const r = await undo('LSC22_1')
    expect(r).toEqual({ changed: false, reply: 'LSC22_1: không hoàn tác được — dòng LSC22_1 đã có file in làm sau lần chuyển.' })
    expect(await lineOf(22)).toMatchObject({ resolvedSupplierId: newSupplierId })
  })

  it('linked default template refuses', async () => {
    const r = await change('LSC16_1', { supplierSku: 'NEW-DEF' })
    expect(r).toEqual({ changed: false, reply: 'LSC16_1: SKU NEW-DEF của LSC Xưởng Mới chưa có template in riêng (template mặc định của xưởng không được tính). Hãy tạo template cho SKU này trên tool rồi nhắn lại.' })
    await expectUntouched(16)
    expect(await profileOf('PMISC')).toBeNull()
  })

  it('linked template of another supplier refuses', async () => {
    const r = await change('LSC16_1', { supplierSku: 'NEW-OTHER' })
    expect(r).toEqual({ changed: false, reply: 'LSC16_1: SKU NEW-OTHER của LSC Xưởng Mới chưa có template in riêng (template mặc định của xưởng không được tính). Hãy tạo template cho SKU này trên tool rồi nhắn lại.' })
    await expectUntouched(16)
    expect(await profileOf('PMISC')).toBeNull()
  })

  it('profile pin of the target supplier is the one named', async () => {
    await prisma.productProfile.create({ data: { storeId: fx.storeId, shopifyProductId: 'PPINTPL', title: 'Hoodie', printTemplateId: pinnedTemplateId } })
    const refused = await change('LSC27_1', { supplierSku: 'NEW-HD-M' })
    expect(refused).toEqual({ changed: false, reply: 'LSC27_1: SKU NEW-HD-M của LSC Xưởng Mới sẽ dùng template "LSC Hoodie L" đang ghim ở sản phẩm, không phải template riêng của SKU này. Hãy sửa template của sản phẩm trên tool rồi nhắn lại.' })
    await expectUntouched(27)
    expect((await profileOf('PPINTPL'))!.overrides).toBe('[]')
    expect(await changesOf('LSC27_1')).toHaveLength(0)
    const ok = await change('LSC27_1', { supplierSku: 'NEW-HD-L' })
    expect(ok.reply).toBe('LSC27_1: đã chuyển sang LSC Xưởng Mới, SKU NEW-HD-L, template LSC Hoodie L. Đã đổi 1 dòng cùng biến thể.')
  })

  it('colour-keyed supplier with no matching sibling rolls back and refuses', async () => {
    const snapshotBefore = (await prisma.designTask.findUniqueOrThrow({ where: { taskKey: 'LSC28_1' } })).supplierSnapshot
    const r = await change('LSC28_1', { supplierSku: 'COL-M-RED' })
    expect(r.changed).toBe(false)
    expect(r.reply).toBe('LSC28_1: không chuyển được — dòng LSC28_1: mapping của LSC Xưởng Mới không tìm được SKU đúng kích cỡ, màu của dòng này khi dùng COL-M-RED. Chưa đổi gì.')
    await expectUntouched(28)
    expect(await profileOf('PCOL')).toBeNull()
    expect(await changesOf('LSC28_1')).toHaveLength(0)
    expect((await eventsOf('LSC28_1')).filter(m => m.startsWith('Chuyển xưởng'))).toEqual([])
    expect((await prisma.designTask.findUniqueOrThrow({ where: { taskKey: 'LSC28_1' } })).supplierSnapshot).toBe(snapshotBefore)
  })

  it('undo leaves a re-mapped line alone', async () => {
    expect((await change('LSC29_1')).changed).toBe(true)
    await prisma.orderLine.updateMany({ where: { orderId: 'gid://test/Order/lsc-30' }, data: { resolvedSupplierId: fx.supplierId, resolvedSupplierSku: 'HAND-SKU', resolvedBaseCost: 3 } })
    const r = await undo('LSC29_1')
    expect(r).toEqual({ changed: true, reply: 'LSC29_1: đã hoàn tác, trả về LSC Supplier, SKU OLD-SKU. Đã đổi lại 1 dòng cùng biến thể. Giữ nguyên LSC30_1 vì đã được đổi xưởng sau lần chuyển.' })
    await expectUntouched(29)
    expect(await lineOf(30)).toMatchObject({ resolvedSupplierId: fx.supplierId, resolvedSupplierSku: 'HAND-SKU', resolvedBaseCost: 3 })
    expect(await eventsOf('LSC30_1')).not.toContain('Hoàn tác chuyển xưởng theo yêu cầu của Lan trên Lark: LSC Xưởng Mới về LSC Supplier (OLD-SKU)')
  })

  it('undo refuses when the override was edited since', async () => {
    expect((await change('LSC31_1')).changed).toBe(true)
    const profile = (await profileOf('PUNDO5'))!
    const edited = JSON.stringify([{ combo: M, supplierProductId: sp['NEW-HD-L'] }])
    await prisma.productProfile.update({ where: { id: profile.id }, data: { overrides: edited } })
    const r = await undo('LSC31_1')
    expect(r).toEqual({ changed: false, reply: 'LSC31_1: không hoàn tác được — mapping của biến thể này đã được sửa sau lần chuyển, hiện trỏ tới SKU NEW-HD-L của LSC Xưởng Mới. Hãy sửa trên tool.' })
    expect((await profileOf('PUNDO5'))!.overrides).toBe(edited)
    expect(await lineOf(31)).toMatchObject({ resolvedSupplierId: newSupplierId, resolvedSupplierSku: 'NEW-HD-M' })
    expect((await changesOf('LSC31_1'))[0].undoneAt).toBeNull()
  })

  it('undo names newer orders that keep the new supplier', async () => {
    expect((await change('LSC32_1')).changed).toBe(true)
    await order(33, [{ product: 'PUNDO6', options: M }])
    await prisma.orderLine.updateMany({ where: { orderId: 'gid://test/Order/lsc-33' }, data: { resolvedSupplierId: newSupplierId, resolvedSupplierSku: 'NEW-HD-M', resolvedBaseCost: 7 } })
    const r = await undo('LSC32_1')
    expect(r).toEqual({ changed: true, reply: 'LSC32_1: đã hoàn tác, trả về LSC Supplier, SKU OLD-SKU. Đã đổi lại 1 dòng cùng biến thể. Còn 1 dòng cùng biến thể đến sau lần chuyển vẫn ở LSC Xưởng Mới: LSC33_1. Hãy kiểm tra trên tool.' })
    await expectUntouched(32)
    expect(await lineOf(33)).toMatchObject({ resolvedSupplierId: newSupplierId, resolvedSupplierSku: 'NEW-HD-M', resolvedBaseCost: 7 })
  })

  it('single incidental word does not pick a product', async () => {
    const r = await change('LSC16_1', { supplierSku: '', instruction: 'chuyển sang loại jacket' })
    expect(r).toEqual({ changed: false, reply: 'LSC16_1: chưa xác định được sản phẩm của LSC Xưởng Mới. Hãy ghi đúng SKU xưởng. Gợi ý: WB-9' })
    const twoWords = await change('LSC16_1', { supplierSku: '', instruction: 'chuyển sang windbreaker jacket' })
    expect(twoWords.reply).toContain('SKU WB-9 của LSC Xưởng Mới chưa có template in riêng')
    const bySkuWord = await change('LSC16_1', { supplierSku: '', instruction: 'chuyển sang wb-9' })
    expect(bySkuWord.reply).toContain('SKU WB-9 của LSC Xưởng Mới chưa có template in riêng')
    await expectUntouched(16)
    expect(await profileOf('PMISC')).toBeNull()
  })
})

describe('supplier change through the bot', () => {
  const lark = {
    reply: vi.fn<(id: string, text: string) => Promise<void>>(async () => {}),
    sendToChat: vi.fn(async () => {}),
    botOpenId: vi.fn(async () => 'ou_bot' as string | null),
    userName: vi.fn(async () => 'Lan' as string | null),
  }
  const fakeLlm = (output: unknown) => ({ complete: vi.fn(async () => ({ output, tokensIn: 1, tokensOut: 1 })) }) as unknown as Llm
  let seq = 0
  async function run(text: string, intent: Partial<LarkIntent>) {
    seq++
    const m: AcceptedLarkMessage = { eventId: `lsc-ev-${seq}`, messageId: `lsc-om-${seq}`, senderOpenId: 'ou_lan_123456', text: `@_user_1 ${text}`, mentions: [{ key: '@_user_1', openId: 'ou_bot', name: 'Design Bot' }] }
    await prisma.larkEvent.create({ data: { eventId: m.eventId, messageId: m.messageId, senderOpenId: m.senderOpenId, text: m.text } })
    const full: LarkIntent = { scope: 'DESIGN_STUDIO', kind: 'SUPPLIER_CHANGE', lineKeys: [], instruction: '', supplierName: '', supplierSku: '', ...intent }
    return processLarkMessage(m, { lark, llm: { llm: fakeLlm(full), model: 'm', cap: 100000 } })
  }

  it('two lines in one message refused', async () => {
    const before = await allChanges()
    const r = await run('LSC23_1 LSC16_1 chuyển sang LSC Xưởng Mới SKU NEW-HD-L', { lineKeys: ['LSC23_1', 'LSC16_1'], supplierName: NEW_NAME, supplierSku: 'NEW-HD-L' })
    expect(r).toMatchObject({ outcome: 'REPLIED', reply: 'Mỗi lần chỉ chuyển xưởng một dòng.', jobIds: [] })
    const undoTwo = await run('hoàn tác chuyển xưởng LSC23_1 LSC16_1', { kind: 'SUPPLIER_UNDO', lineKeys: ['LSC23_1', 'LSC16_1'] })
    expect(undoTwo.reply).toBe('Mỗi lần chỉ chuyển xưởng một dòng.')
    const withUnknown = await run('LSC23_1 LSC999_1 chuyển sang LSC Xưởng Mới', { lineKeys: ['LSC23_1', 'LSC999_1'], supplierName: NEW_NAME, supplierSku: 'NEW-HD-L' })
    expect(withUnknown.reply).toBe('Mỗi lần chỉ chuyển xưởng một dòng.')
    expect(await allChanges()).toBe(before)
    await expectUntouched(23)
  })

  it('one line: the bot changes it, then undoes it', async () => {
    const r = await run('LSC23_1 chuyển sang LSC Xưởng Mới SKU NEW-HD-L', { lineKeys: ['LSC23_1'], supplierName: NEW_NAME, supplierSku: 'NEW-HD-L', instruction: 'chuyển xưởng' })
    expect(r).toMatchObject({ outcome: 'REPLIED', jobIds: [], reply: 'LSC23_1: đã chuyển sang LSC Xưởng Mới, SKU NEW-HD-L, template LSC Hoodie L. Đã đổi 1 dòng cùng biến thể.' })
    expect(await lineOf(23)).toMatchObject({ resolvedSupplierId: newSupplierId, resolvedSupplierSku: 'NEW-HD-L' })
    expect((await changesOf('LSC23_1'))[0].requestedBy).toBe('Lan')
    const back = await run('hoàn tác chuyển xưởng LSC23_1', { kind: 'SUPPLIER_UNDO', lineKeys: ['LSC23_1'] })
    expect(back.reply).toBe('LSC23_1: đã hoàn tác, trả về LSC Supplier, SKU OLD-SKU. Đã đổi lại 1 dòng cùng biến thể.')
    await expectUntouched(23)
    expect(await prisma.designAgentJob.count({ where: { taskKey: 'LSC23_1' } })).toBe(0)
  })

  it('no line named: asks for the line', async () => {
    const r = await run('chuyển sang LSC Xưởng Mới', { supplierName: NEW_NAME })
    expect(r.reply).toBe('Chưa rõ đơn nào. Hãy gửi mã đơn và dòng, ví dụ: LIT6262_1.')
  })
})
