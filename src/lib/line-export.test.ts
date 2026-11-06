import { describe, it, expect } from 'vitest'
import { canSendBeside, pushFileTokens, pushedShopifyLineIds } from './line-export'

// The order sync makes every OrderLine anew on each read (new ids, same Shopify line ids).
const before = [
  { id: 'ol-1', shopifyLineId: 'gid/1', exportedToSupplierId: 'BONDRE' },
  { id: 'ol-2', shopifyLineId: 'gid/2', exportedToSupplierId: null },
]
const after = before.map((l, i) => ({ ...l, id: `ol-new-${i + 1}` }))
const push = (stored: Record<string, unknown> | null, more: Record<string, unknown> = {}) => ({
  supplierId: 'BONDRE', status: 'CREATED', exportMarked: true, prevExportJson: stored ? JSON.stringify(stored) : null, ...more,
})

describe('pushedShopifyLineIds', () => {
  it('a push that recorded Shopify line ids carries those lines, before and after a re-sync', () => {
    const p = push({ lineIds: ['ol-1'], shopifyLineIds: ['gid/1'] })
    expect(pushedShopifyLineIds(p, before)).toEqual(['gid/1'])
    expect(pushedShopifyLineIds(p, after)).toEqual(['gid/1'])
  })

  it('an older push with OrderLine ids still on the order carries those lines', () => {
    expect(pushedShopifyLineIds(push({ lineIds: ['ol-2'] }), before)).toEqual(['gid/2'])
  })

  it('an older push whose OrderLine ids are gone carries the lines whose files it sent, else the lines exported to its supplier', () => {
    const p = push({ lineIds: ['ol-2'] })
    expect(pushedShopifyLineIds(p, after, ['gid/2'])).toEqual(['gid/2'])
    expect(pushedShopifyLineIds(p, after)).toEqual(['gid/1'])
    expect(pushedShopifyLineIds(p, after, [])).toEqual(['gid/1'])
  })

  it('a push from before sends went by line carries every line of its supplier (null)', () => {
    expect(pushedShopifyLineIds(push(null), after)).toBeNull()
    expect(pushedShopifyLineIds(push({ pipelineStatus: 'EXPORTED', linesMarked: 1 }), after)).toBeNull()
  })
})

describe('canSendBeside', () => {
  // The lines about to be sent, as the build read them.
  const sending = (lines: typeof before, n: number) => [lines[n - 1]]

  it('gives the same answer before and after a re-sync', () => {
    const live = [push({ lineIds: ['ol-1'], shopifyLineIds: ['gid/1'] })]
    expect(canSendBeside(live, sending(before, 2))).toBe(true)
    expect(canSendBeside(live, sending(after, 2))).toBe(true)
    expect(canSendBeside(live, sending(before, 1))).toBe(false)
    expect(canSendBeside(live, sending(after, 1))).toBe(false)
  })

  it('an older push whose ids are gone still holds the line it marked exported', () => {
    const live = [push({ lineIds: ['ol-1'] })]
    expect(canSendBeside(live, sending(before, 1))).toBe(false)
    expect(canSendBeside(live, sending(after, 1))).toBe(false)
    expect(canSendBeside(live, sending(after, 2))).toBe(true)
  })

  it('still refuses a push not landed or not marked, or one that carried every line', () => {
    expect(canSendBeside([push({ lineIds: ['ol-1'], shopifyLineIds: ['gid/1'] }, { status: 'SENDING' })], sending(before, 2))).toBe(false)
    expect(canSendBeside([push({ lineIds: ['ol-1'], shopifyLineIds: ['gid/1'] }, { exportMarked: false })], sending(before, 2))).toBe(false)
    expect(canSendBeside([push(null)], sending(before, 2))).toBe(false)
    expect(canSendBeside([], sending(before, 1))).toBe(true)
  })
})

describe('pushFileTokens', () => {
  it('reads the artwork tokens of every public file link a push sent, once each', () => {
    const t1 = 'a'.repeat(64)
    const t2 = 'b'.repeat(64)
    const body = JSON.stringify({ packages: [{ items: [
      { design1: `https://tool.example/api/public/artwork/${t1}/print.png`, mockup1: `https://tool.example/api/public/artwork/${t2}/mockup.png` },
      { design1: `https://tool.example/api/public/artwork/${t1}/print.png`, mockup1: 'https://cdn.shopify.com/s/files/x.jpg' },
    ] }] })
    expect(pushFileTokens(body)).toEqual([t1, t2])
    expect(pushFileTokens('{}')).toEqual([])
    expect(pushFileTokens(null)).toEqual([])
  })
})
