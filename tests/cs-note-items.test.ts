import { describe, it, expect } from 'vitest'
import { noteHtml } from '@/lib/cs/actions'
import { itemSummaryVi } from '@/lib/cs/order-context'

const parcel = { trackingNumber: 'UL645924611YP', carrier: 'Yodel', status: 'DELIVERED', lastEvent: 'Delivered, handed to customer', lastEventAt: new Date('2026-11-09T12:55:01Z'), deliveredAt: new Date('2026-11-09T12:55:01Z'), trackingUrl: null, fromSupplier: 'Mangoshao', sharedWith: ['LIT4987_2'] }
const tumbler = { lineKey: 'LIT4987_1', title: 'Tumbler', variant: '20oz', qty: 1, send: null, parcel, warning: 'Không tìm được thông tin gửi xưởng mà sản phẩm đã gắn tracking UL645924611YP' }
const hoodie = { lineKey: 'LIT4987_2', title: 'Zip Hoodie', variant: '2XL', qty: 1, send: { supplier: 'Mangoshao', via: 'SHEET' as const, ref: 'CN_POD_MS-20261028', sentAt: new Date('2026-10-28T01:52:59Z'), factoryStatus: null, checkedAt: null }, parcel: null, warning: null }

describe('itemSummaryVi', () => {
  it('answers sent-or-not and where the parcel is, in Vietnamese', () => {
    expect(itemSummaryVi(hoodie)).toBe('LIT4987_2 Zip Hoodie (2XL): gửi Mangoshao qua sheet CN_POD_MS-20261028 ngày 10/28/2026 · chưa có tracking')
    expect(itemSummaryVi(tumbler)).toBe('LIT4987_1 Tumbler (20oz): không tìm được thông tin gửi xưởng · UL645924611YP Yodel DELIVERED, giao 11/09/2026, scan 11/09/2026 "Delivered, handed to customer", chung kiện với LIT4987_2 · ⚠ Không tìm được thông tin gửi xưởng mà sản phẩm đã gắn tracking UL645924611YP')
  })
  it('shows the factory status an API reported', () => {
    expect(itemSummaryVi({ ...hoodie, send: { supplier: 'Pgprints', via: 'API', ref: 'PG8160-1060', sentAt: new Date('2026-10-26T05:44:26Z'), factoryStatus: 'in-production', checkedAt: new Date('2026-11-07T20:30:00Z') } }))
      .toContain('gửi Pgprints qua API PG8160-1060 ngày 10/26/2026, xưởng báo in-production (11/07/2026)')
  })
})

describe('noteHtml', () => {
  const a = { category: 'MISSING_ITEM', urgency: 'HIGH', summary: 'Vấn đề: Khách nhận thiếu Tumbler 20oz "Malek"\nĐơn hàng:\n1- Pgprints không có\n2- Mango cũng không có\n=> Kết luận giả định: Chưa gửi hàng', proposal: '1- Email xin lỗi khách\n2- Gửi ngay món còn thiếu', outputJson: JSON.stringify({ facts: ['Thiếu 1/2 tumbler', 'Tên Malek'] }) } as any
  const ticket = { id: 't1', orderNumber: '#LIT4987' } as any
  it('three parts in order: red summary, proposal, then details', () => {
    const html = noteHtml(a, ticket, 'https://app', [tumbler, hoodie])
    const at = (s: string) => html.indexOf(s)
    expect(at('Vấn đề:')).toBeGreaterThan(-1)
    expect(at('Vấn đề:')).toBeLessThan(at('<b>Đề xuất:</b>'))
    expect(html).not.toContain('Tóm tắt')
    expect(at('<b>Đề xuất:</b>')).toBeLessThan(at('<b>Chi tiết</b>'))
    expect(html).toContain('<span style="color:#d32f2f">Vấn đề: Khách nhận thiếu Tumbler 20oz &quot;Malek&quot;<br>Đơn hàng:<br>1- Pgprints không có<br>2- Mango cũng không có<br>=&gt; Kết luận giả định: Chưa gửi hàng</span>')
    expect(html).toContain('<b>Đề xuất:</b><br>1- Email xin lỗi khách<br>2- Gửi ngay món còn thiếu')
    expect(at('2- Gửi ngay món còn thiếu')).toBeLessThan(at('<b>Chi tiết</b>'))
  })
  it('details hold each item, what the customer stated and the ticket link', () => {
    const html = noteHtml(a, ticket, 'https://app', [tumbler, hoodie])
    const details = html.slice(html.indexOf('<b>Chi tiết</b>'))
    expect(html).toContain('<details><summary><b>Chi tiết</b></summary>')
    expect(html.trim().endsWith('</details>')).toBe(true)
    expect(details).toContain('LIT4987_2 Zip Hoodie (2XL): gửi Mangoshao')
    expect(details).toContain('&quot;Delivered, handed to customer&quot;')
    expect(details).toContain('Khách nêu: Thiếu 1/2 tumbler; Tên Malek')
    expect(details).toContain('https://app/cs/t1')
  })
  it('no item lines when there is no order', () => {
    expect(noteHtml(a, ticket, 'https://app')).not.toContain('Từng sản phẩm')
  })
})
