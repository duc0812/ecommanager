import { describe, it, expect } from 'vitest'
import { heldByLivePush } from './line-export'
import { planPushLines } from './repos/push-export'
import { pushByLineFor } from './supplier-handoff'

// LIT6467 (owner 11/22/2026): line 3 sits in a landed Merchize order but a fix reopened it and took its mark; line 1 was
// approved later for the same supplier; line 2 went to Jomall by sheet.
const MZ = 'sup-merchize', JM = 'sup-jomall'
const line = (n: number, supplier: string, exportedAt: Date | null = null) => ({
  id: `ol-${n}`, shopifyLineId: `gid/${n}`, sku: `SKU-${n}`, productTitle: `Product ${n}`, shopifyProductType: 'Shirt',
  resolvedSupplierId: supplier, resolvedSupplierSku: `S-${n}`, designDriveLink: 'https://drive/x', dropship: false,
  exportedAt, exportedToSupplierId: exportedAt ? supplier : null, linePosition: n,
})
const oldPush = {
  supplierId: MZ, status: 'CREATED', exportMarked: true, externalOrderId: 'LIT6467', supplierOrderCode: 'RX-1', createdAt: new Date('2026-11-18'),
  prevExportJson: JSON.stringify({ lineIds: ['ol-old-3'], shopifyLineIds: ['gid/3'] }),
}
const lines = [line(1, MZ), line(2, JM, new Date('2026-11-18')), line(3, MZ)]
const tasks = [1, 2, 3].map(n => ({ shopifyLineId: `gid/${n}`, status: 'DONE', updatedAt: new Date('2026-11-20') }))
const order = {
  pipelineStatus: 'READY_TO_PRODUCTION', financialStatus: 'PAID', fulfillmentStatus: null, designReady: true, supplierHandoffAt: null,
  exportedAt: null, exportedToSupplierId: null, lines, designTasks: tasks, supplierPushes: [oldPush],
}

describe('heldByLivePush', () => {
  it('a landed, marked push holds the line it recorded, after a fix took the line mark', () => {
    expect(heldByLivePush([oldPush], lines[2])).toBe(true)
    expect(heldByLivePush([oldPush], lines[0])).toBe(false)
    expect(heldByLivePush([oldPush], lines[1])).toBe(false)
  })
  it('only a CREATED, marked push of the same supplier, and only with recorded lines', () => {
    expect(heldByLivePush([{ ...oldPush, status: 'SENDING' }], lines[2])).toBe(false)
    expect(heldByLivePush([{ ...oldPush, exportMarked: false }], lines[2])).toBe(false)
    expect(heldByLivePush([{ ...oldPush, supplierId: JM }], lines[2])).toBe(false)
    expect(heldByLivePush([{ ...oldPush, prevExportJson: null }], lines[2])).toBe(false)
    expect(heldByLivePush([{ ...oldPush, prevExportJson: JSON.stringify({ lineIds: ['ol-3'] }) }], lines[2])).toBe(true)
  })
})

describe('planPushLines', () => {
  it('sends the later line beside the live push instead of refusing the order', () => {
    const plan = planPushLines(order, [lines[0], lines[2]], [oldPush])
    expect(plan.later).toBe(true)
    expect(plan.lines.map(l => l.id)).toEqual(['ol-1'])
  })
  it('with nothing new to send it still answers with the live push (no second order)', () => {
    const plan = planPushLines(order, [lines[2]], [oldPush])
    expect(plan.later).toBe(false)
  })
})

describe('pushByLineFor', () => {
  const kindOf = (id: string) => (id === MZ ? 'merchize' as const : null)
  it('each line shows the push that carries it, and a line of another supplier none', () => {
    const newPush = { ...oldPush, externalOrderId: 'LIT6467-R2', supplierOrderCode: 'RQ-2', createdAt: new Date('2026-11-22'), prevExportJson: JSON.stringify({ lineIds: ['ol-1'], shopifyLineIds: ['gid/1'] }) }
    const byLine = pushByLineFor({ lines, supplierPushes: [oldPush, newPush] }, kindOf)
    expect(byLine['ol-1']?.supplierOrderCode).toBe('RQ-2')
    expect(byLine['ol-3']?.supplierOrderCode).toBe('RX-1')
    expect(byLine['ol-3']?.apiKind).toBe('merchize')
    expect(byLine['ol-2']).toBeUndefined()
  })
  it('a push from before lines were recorded shows on every line of its supplier', () => {
    const byLine = pushByLineFor({ lines, supplierPushes: [{ ...oldPush, prevExportJson: null }] }, kindOf)
    expect(Object.keys(byLine).sort()).toEqual(['ol-1', 'ol-3'])
  })
})
