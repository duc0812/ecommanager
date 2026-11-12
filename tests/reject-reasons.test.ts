import { describe, it, expect } from 'vitest'
import { otherReasonError, rejectSelection, rejectReasonBucket } from '@/lib/reject-reasons'
import { DEFAULT_DESIGN_SETTINGS } from '@/lib/design-settings'

describe('reject reasons', () => {
  it('rejectSelection', () => {
    expect(rejectSelection(['Sai chi tiết'], false, '')).toEqual({ reasons: ['Sai chi tiết'], error: null })
    expect(rejectSelection(['Sai chi tiết'], true, '  sao trên mũ lệch ')).toEqual({ reasons: ['Sai chi tiết', 'Khác: sao trên mũ lệch'], error: null })
    expect(rejectSelection([], true, 'ab').error).toBe('Lý do khác dài từ 3 đến 200 ký tự')
    expect(rejectSelection([], true, 'x'.repeat(201)).error).toBe('Lý do khác dài từ 3 đến 200 ký tự')
    expect(rejectSelection([], false, '').error).toBe('Chọn ít nhất một lý do')
  })

  it('the "Lý do khác" error waits until the leader typed or tried to submit', () => {
    expect(otherReasonError(true, '', false)).toBeNull()
    expect(otherReasonError(true, 'ab', true)).toBe('Lý do khác dài từ 3 đến 200 ký tự')
    expect(otherReasonError(true, '', true)).toBe('Lý do khác dài từ 3 đến 200 ký tự')
    expect(otherReasonError(true, 'sao lệch', true)).toBeNull()
    expect(otherReasonError(false, '', true)).toBeNull()
  })

  it('every "Khác: …" counts under "Lý do khác"', () => {
    expect(['Khác: sao lệch', 'Khác: thiếu viền', 'Sai chi tiết'].map(rejectReasonBucket)).toEqual(['Lý do khác', 'Lý do khác', 'Sai chi tiết'])
  })

  it('the defaults carry the four new reasons', () => {
    expect(DEFAULT_DESIGN_SETTINGS.rejectReasons.slice(-4)).toEqual(['Nền không đồng màu giữa các mảnh', 'Hoạ tiết chính nằm ngoài safe zone', 'Sai template đang mapping', 'Sai chi tiết'])
    expect(DEFAULT_DESIGN_SETTINGS.rejectReasons).toHaveLength(10)
  })
})
