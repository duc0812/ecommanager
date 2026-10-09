import { describe, it, expect } from 'vitest'
import { autoRenderEligibility, customerValues, renderFields, type AutoRenderInput } from '@/lib/artwork-render-eligibility'

const layer = (field: string) => ({ field, layer: `@${field}`, fit: 'shrink' })
const base: AutoRenderInput = {
  taskStatus: 'NEW', hasTemplate: true, slots: ['Print'],
  library: { entryId: 'e1', status: 'READY', layers: [layer('Custom Name'), layer('Custom Name')] },
  personalization: [{ key: 'Custom Name: Yes Or No?', value: 'Yes' }, { key: 'custom name ', value: ' Marie-Pier ' }],
  job: null,
}

describe('auto render eligibility', () => {
  it('is ready when the entry is READY and every field has a value', () => {
    expect(autoRenderEligibility(base)).toEqual({ ok: true, busy: false, reason: null, fields: ['Custom Name'], missing: [] })
  })

  it('placements of one field need the value once; names match ignoring case and spaces', () => {
    expect(renderFields(base.library)).toEqual(['Custom Name'])
    expect(customerValues(['Custom Name'], base.personalization)).toEqual({ 'Custom Name': 'Marie-Pier' })
  })

  it('explains why the button is disabled', () => {
    expect(autoRenderEligibility({ ...base, personalization: [] }).reason).toBe('Khách chưa điền: Custom Name')
    expect(autoRenderEligibility({ ...base, personalization: [{ key: 'Custom Name', value: '   ' }] }).missing).toEqual(['Custom Name'])
    expect(autoRenderEligibility({ ...base, library: { ...base.library!, status: 'NEEDS_REVIEW' } }).reason).toBe('Artwork gốc chưa sẵn sàng (chờ duyệt)')
    expect(autoRenderEligibility({ ...base, library: { entryId: null, status: 'NONE', layers: [] } }).reason).toBe('Chưa có artwork gốc cho template này')
    expect(autoRenderEligibility({ ...base, library: null }).ok).toBe(false)
    expect(autoRenderEligibility({ ...base, hasTemplate: false }).reason).toBe('Dòng chưa có template in')
    expect(autoRenderEligibility({ ...base, slots: [] }).reason).toBe('Template không có vùng in')
    expect(autoRenderEligibility({ ...base, taskStatus: 'DONE' }).reason).toBe('Task đã đóng')
  })

  it('is busy while a job is queued or running, and can retry after DONE or FAILED', () => {
    expect(autoRenderEligibility({ ...base, job: { status: 'RUNNING' } })).toMatchObject({ ok: false, busy: true })
    expect(autoRenderEligibility({ ...base, job: { status: 'QUEUED' } }).busy).toBe(true)
    expect(autoRenderEligibility({ ...base, job: { status: 'FAILED' } }).ok).toBe(true)
    expect(autoRenderEligibility({ ...base, job: { status: 'DONE' } }).ok).toBe(true)
  })

  it('an entry without custom fields renders the artwork alone', () => {
    expect(autoRenderEligibility({ ...base, library: { ...base.library!, layers: [] }, personalization: [] }).ok).toBe(true)
  })
})
