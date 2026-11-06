import { describe, it, expect } from 'vitest'
import { leftoverProductId, showsReused, visibleStage, type CloneJobView, type CloneStatus, type Viewer } from '@/app/fulfillment/clone/components/types'

const STATUSES: CloneStatus[] = ['QUEUED', 'RUNNING', 'DONE', 'FAILED', 'CANCELLED']
const GID = 'gid://shopify/Product/9054123557021'
const SUPER: Viewer = { id: 'u0', role: 'SUPERADMIN', superadmin: true }
const SELLER: Viewer = { id: 'u1', role: 'SELLER', superadmin: false }
const ADMIN: Viewer = { id: 'u2', role: 'ADMIN', superadmin: false }

const job = (over: Partial<CloneJobView>): CloneJobView => ({
  id: 'j1', storeId: 's1', sourceUrl: 'https://shop.example.com/products/a', status: 'QUEUED', failKind: null, stage: null, skuCode: 'ZZ2611060001',
  requestedById: 'u1', requestedByName: 'Seller A', productUrl: null, productGid: null, reused: false, error: null, createdAt: '2026-11-06T00:00:00.000Z',
  ...over,
})

describe('bảng job clone', () => {
  it('stage chỉ hiện khi job đang chạy: job lỗi ở bước qa không hiện "qa"', () => {
    expect(visibleStage(job({ status: 'RUNNING', stage: 'qa' }))).toBe('qa')
    expect(visibleStage(job({ status: 'RUNNING', stage: null }))).toBeNull()
    for (const status of STATUSES.filter(s => s !== 'RUNNING')) expect(visibleStage(job({ status, stage: 'qa' })), status).toBeNull()
  })

  it('"Đã có sẵn" chỉ khi job xong và reused', () => {
    expect(showsReused(job({ status: 'DONE', reused: true }))).toBe(true)
    expect(showsReused(job({ status: 'DONE', reused: false }))).toBe(false)
    for (const status of STATUSES.filter(s => s !== 'DONE')) expect(showsReused(job({ status, reused: true })), status).toBe(false)
  })

  it('job lỗi còn để lại sản phẩm: chỉ SUPERADMIN thấy số id của sản phẩm', () => {
    expect(leftoverProductId(job({ status: 'FAILED', productGid: GID }), SUPER)).toBe('9054123557021')
    for (const viewer of [SELLER, ADMIN]) expect(leftoverProductId(job({ status: 'FAILED', productGid: GID }), viewer)).toBeNull()
    for (const status of STATUSES.filter(s => s !== 'FAILED')) expect(leftoverProductId(job({ status, productGid: GID }), SUPER), status).toBeNull()
    for (const productGid of [null, '', 'gid://shopify/ProductVariant/1', `${GID}<b>`, '9054123557021']) {
      expect(leftoverProductId(job({ status: 'FAILED', productGid }), SUPER), String(productGid)).toBeNull()
    }
  })
})
