import { describe, it, expect } from 'vitest'
import {
  canRetry, leftoverProductId, reportedProductId, retryQuestion, showsReused, visibleStage, type CloneJobView, type CloneStatus, type Viewer,
} from '@/app/fulfillment/clone/components/types'

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

  it('job lỗi còn sản phẩm trên store: seller không có nút Thử lại, SUPERADMIN có', () => {
    const left = job({ status: 'FAILED', failKind: 'TOOL', productGid: GID })
    expect(canRetry(left, SELLER)).toBe(false)
    expect(canRetry(left, SUPER)).toBe(true)
    expect(canRetry(job({ status: 'FAILED', failKind: 'TOOL', productGid: null }), SELLER)).toBe(true)
  })

  it('SUPERADMIN thử lại job còn sản phẩm: hỏi trước, nêu số id sản phẩm; job không còn sản phẩm thì không hỏi', () => {
    expect(retryQuestion(job({ status: 'FAILED', productGid: GID }), SUPER)).toBe(
      'Job này còn sản phẩm 9054123557021 trên store. Xoá hoặc chuyển nháp sản phẩm đó trước khi thử lại. Thử lại bây giờ?',
    )
    expect(retryQuestion(job({ status: 'FAILED', productGid: null }), SUPER)).toBeNull()
    expect(retryQuestion(job({ status: 'FAILED', productGid: GID }), SELLER)).toBeNull()
  })

  it('gid của job reused (sản phẩm gốc) hay của lỗi VERIFY không phải sản phẩm còn lại: không khuyên xoá, không chặn, chỉ ghi "Sản phẩm được báo"', () => {
    const named = [
      job({ status: 'FAILED', failKind: 'VERIFY', productGid: GID }),
      job({ status: 'FAILED', failKind: 'TOOL', productGid: GID, reused: true }),
      job({ status: 'FAILED', failKind: 'VERIFY', productGid: GID, reused: true }),
    ]
    for (const j of named) {
      expect(leftoverProductId(j, SUPER)).toBeNull()
      expect(retryQuestion(j, SUPER)).toBeNull()
      expect(canRetry(j, SELLER)).toBe(true)
      expect(reportedProductId(j, SUPER)).toBe('9054123557021')
      for (const viewer of [SELLER, ADMIN]) expect(reportedProductId(j, viewer)).toBeNull()
    }
    expect(reportedProductId(job({ status: 'FAILED', failKind: 'TOOL', productGid: GID }), SUPER)).toBeNull()
    expect(reportedProductId(job({ status: 'FAILED', failKind: 'VERIFY', productGid: null }), SUPER)).toBeNull()
    expect(reportedProductId(job({ status: 'DONE', failKind: null, productGid: GID, reused: true }), SUPER)).toBeNull()
  })
})
