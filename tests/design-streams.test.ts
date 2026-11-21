import { describe, it, expect } from 'vitest'
import { HANDOFF_GROUPS, STREAMS, TASK_GROUPS, byDue, groupCounts, groupOf, groupTasks, streamCounts, streamOf, urgencyOf, flagNotes } from '@/app/design-studio/components/streams'

const NOW = Date.parse('2026-11-21T10:00:00Z')
const at = (hours: number) => new Date(NOW + hours * 3600_000).toISOString()
const task = (over: Partial<any> = {}): any => ({ taskKey: 'K', status: 'NEW', dueAt: at(10), mapping: 'READY', dropship: false, readiness: 'AUTO', ...over })

describe('urgencyOf', () => {
  it('quá hạn, còn ≤4h, còn hạn, chưa hạn', () => {
    expect(urgencyOf(at(-0.01), NOW)).toBe('OVER')
    expect(urgencyOf(at(4.99), NOW)).toBe('SOON')   // timeLeft shows "còn 4h" here too
    expect(urgencyOf(at(5), NOW)).toBe('OK')
    expect(urgencyOf(null, NOW)).toBe('OK')
  })
})

describe('streamOf — vướng gì tính luồng đứng trước', () => {
  it('unmapped beats everything, even REVIEW and REJECTED', () => {
    expect(streamOf(task({ mapping: 'UNMAPPED', status: 'REVIEW' }))).toBe('MAP')
    expect(streamOf(task({ mapping: 'UNMAPPED', status: 'REJECTED' }))).toBe('MAP')
  })
  it('no template only catches tasks that have not started', () => {
    expect(streamOf(task({ status: 'DONE', mapping: 'UNMAPPED' }))).toBe('FILE')
    expect(streamOf(task({ mapping: 'NO_TEMPLATE', status: 'NEW' }))).toBe('TPL')
    expect(streamOf(task({ mapping: 'NO_TEMPLATE', status: 'ASSIGNED' }))).toBe('TPL')
    expect(streamOf(task({ mapping: 'NO_TEMPLATE', status: 'DOING' }))).toBe('FILE')
    expect(streamOf(task({ mapping: 'NO_TEMPLATE', status: 'REVIEW' }))).toBe('REVIEW')
    expect(streamOf(task({ mapping: 'NO_TEMPLATE', status: 'REJECTED' }))).toBe('FILE')
    expect(streamOf(task({ mapping: 'NO_TEMPLATE', status: 'ASK_CUSTOMER' }))).toBe('FILE')
  })
  it('REVIEW → Duyệt mẫu; DONE stays in Files in (Xong hôm nay); CANCELLED is in no stream', () => {
    expect(streamOf(task({ status: 'REVIEW' }))).toBe('REVIEW')
    expect(streamOf(task({ status: 'DONE' }))).toBe('FILE')
    expect(streamOf(task({ status: 'CANCELLED' }))).toBeNull()
    expect(streamOf(task({ status: 'CANCELLED', dropship: true }))).toBeNull()
    expect(streamOf(task({ status: 'DONE', mapping: 'UNMAPPED' }))).toBe('FILE')
    expect(STREAMS.map(s => s.id)).toEqual(['MAP', 'TPL', 'FILE', 'REVIEW', 'HANDOFF', 'SENT', 'DROPSHIP'])
  })
})

describe('groupOf', () => {
  const g = (t: any) => groupOf(TASK_GROUPS.FILE, t, NOW).id
  it('Files in: gấp / cần sửa gấp / sắp / cần sửa / chờ khách / còn hạn / xong', () => {
    expect(g(task({ status: 'DOING', dueAt: at(-1) }))).toBe('FI_URGENT')
    expect(g(task({ status: 'REJECTED', dueAt: at(-1) }))).toBe('FI_FIX_URGENT')
    expect(g(task({ status: 'NEW', dueAt: at(3) }))).toBe('FI_SOON')
    expect(g(task({ status: 'REJECTED', dueAt: at(3) }))).toBe('FI_FIX')
    expect(g(task({ status: 'ASK_CUSTOMER', dueAt: at(-5) }))).toBe('FI_ASK')
    expect(g(task({ status: 'NEW', dueAt: null }))).toBe('FI_OK')
    expect(g(task({ status: 'DONE', dueAt: at(-9) }))).toBe('FI_DONE')
  })
  it('three-tier streams and handoff cards', () => {
    expect(groupOf(TASK_GROUPS.MAP, task({ dueAt: at(-1) }), NOW).title).toBe('Cần mapping gấp')
    expect(groupOf(TASK_GROUPS.TPL, task({ dueAt: at(2) }), NOW).title).toBe('Sắp quá hạn')
    expect(groupOf(TASK_GROUPS.FILE, task({ status: 'DONE', dueAt: at(-9) }), NOW).id).toBe('FI_DONE')   // never "Files in gấp"
    expect(groupOf(TASK_GROUPS.REVIEW, task({ dueAt: null }), NOW).title).toBe('Còn hạn')
    expect(groupOf(HANDOFF_GROUPS, { dueAt: at(-30) }, NOW).title).toBe('Quá hạn — cần gửi xưởng gấp')
    expect(groupOf(HANDOFF_GROUPS, { dueAt: null }, NOW).id).toBe('HO_OK')
  })
})

describe('groupTasks / counts', () => {
  const tasks = [
    task({ taskKey: 'a', status: 'DOING', dueAt: at(-2) }),
    task({ taskKey: 'b', status: 'DOING', dueAt: at(-1) }),
    task({ taskKey: 'c', status: 'NEW', dueAt: null }),
    task({ taskKey: 'd', status: 'REVIEW', dueAt: at(-1) }),
    task({ taskKey: 'e', status: 'NEW', mapping: 'UNMAPPED', dueAt: at(1) }),
    task({ taskKey: 'f', status: 'DONE', dueAt: at(-9) }),
    task({ taskKey: 'g', status: 'CANCELLED' }),
  ]
  it('groups only the stream\'s tasks, drops empty groups, sorts by due with null last', () => {
    const groups = groupTasks('FILE', tasks as any, null, NOW)
    expect(groups.map(g => [g.def.id, g.rows.map((r: any) => r.taskKey)])).toEqual([['FI_URGENT', ['a', 'b']], ['FI_OK', ['c']], ['FI_DONE', ['f']]])
    expect(groupTasks('FILE', tasks as any, 'FI_OK', NOW).map(g => g.def.id)).toEqual(['FI_OK'])
  })
  it('stream counts: open tasks only, overdue per stream, handoff from the API numbers, SENT has no total', () => {
    expect(streamCounts(tasks as any, { count: 7, overdue: 2 }, 3, NOW)).toEqual({
      MAP: { total: 1, overdue: 0 }, TPL: { total: 0, overdue: 0 }, FILE: { total: 3, overdue: 2 },
      REVIEW: { total: 1, overdue: 1 }, HANDOFF: { total: 7, overdue: 2 }, SENT: { total: null, overdue: 0 }, DROPSHIP: { total: 3, overdue: 0 },
    })
    expect(groupCounts('FILE', tasks as any, NOW)).toMatchObject({ FI_URGENT: 2, FI_OK: 1, FI_SOON: 0 })
  })
  it('byDue puts null last', () => {
    expect([{ dueAt: null }, { dueAt: at(1) }, { dueAt: at(-1) }].sort(byDue).map(x => x.dueAt)).toEqual([at(-1), at(1), null])
  })
  it('STREAMS is in pipeline order', () => {
    expect(STREAMS.map(s => s.id)).toEqual(['MAP', 'TPL', 'FILE', 'REVIEW', 'HANDOFF', 'SENT', 'DROPSHIP'])
  })
})

describe('flagNotes', () => {
  const base = { status: 'DOING', dueAt: at(-3), readiness: 'AUTO', mapping: 'READY', stream: 'FILE', inQueue: true, productPageHref: '/design-studio/products/p1' } as const
  it('overdue wording follows the stream', () => {
    expect(flagNotes({ ...base }, NOW)[0]).toMatchObject({ key: 'overdue', tone: 'bad', icon: 'alarm', title: 'Quá hạn 3h — cần file in gấp' })
    expect(flagNotes({ ...base, stream: 'MAP', mapping: 'UNMAPPED' }, NOW)[0].title).toBe('Quá hạn 3h — cần mapping gấp')
    expect(flagNotes({ ...base, stream: 'TPL', mapping: 'NO_TEMPLATE', status: 'NEW' }, NOW)[0].title).toBe('Quá hạn 3h — cần dựng template gấp')
    expect(flagNotes({ ...base, stream: 'REVIEW', status: 'REVIEW' }, NOW)[0].title).toBe('Quá hạn 3h — cần duyệt gấp')
    expect(flagNotes({ ...base, dueAt: at(2) }, NOW).some(n => n.key === 'overdue')).toBe(false)
  })
  it('blockers link to mapping / backlog / product page and say auto render is off', () => {
    const n = flagNotes({ ...base, dueAt: null, stream: 'MAP', mapping: 'UNMAPPED', status: 'NEW' }, NOW)
    expect(n).toHaveLength(1)
    expect(n[0]).toMatchObject({ key: 'blocked', tone: 'warn', icon: 'report', title: 'Đang vướng:' })
    expect(n[0].text).toContain('chưa map xưởng')
    expect(n[0].text).toContain('Task này không render tự động được cho tới khi gỡ xong')
    expect(n[0].links).toEqual([{ label: 'Mở Product Mapping', href: '/fulfillment/mapping' }])
    const t = flagNotes({ ...base, dueAt: null, stream: 'TPL', mapping: 'NO_TEMPLATE', status: 'ASSIGNED' }, NOW)[0]
    expect(t.text).toContain('chưa có template in')
    expect(t.links).toEqual([{ label: 'Mở Tồn đọng', href: '/design-studio/backlog' }, { label: 'Mở trang sản phẩm', href: '/design-studio/products/p1' }])
  })
  it('a started task without a template only gets the short size warning', () => {
    const n = flagNotes({ ...base, dueAt: null, mapping: 'NO_TEMPLATE', status: 'DOING' }, NOW)
    expect(n).toEqual([{ key: 'no-template', tone: 'warn', icon: 'dashboard_customize', title: 'Không có template —', text: 'tự kiểm tra khổ file trước khi gửi duyệt', links: [] }])
  })
  it('LOW without blockers → Cần chỉnh; DONE/CANCELLED outside the queue → note, nothing else', () => {
    expect(flagNotes({ ...base, dueAt: null, readiness: 'LOW' }, NOW)).toEqual([{ key: 'low', tone: 'warn', icon: 'tune', title: 'Cần chỉnh:', text: 'máy đã render file tự động, sửa tay (vị trí / font / màu) rồi mới gửi duyệt.', links: [] }])
    expect(flagNotes({ ...base, status: 'DONE', stream: null, inQueue: false }, NOW)).toEqual([{ key: 'outside', tone: 'idle', icon: 'info', title: 'Task này đã duyệt / đã huỷ,', text: 'không nằm trong hàng đợi.', links: [] }])
    expect(flagNotes({ ...base, status: 'CANCELLED', stream: null, inQueue: false }, NOW)[0].key).toBe('outside')
    expect(flagNotes({ ...base, status: 'DONE', mapping: 'NO_TEMPLATE', inQueue: true }, NOW)).toEqual([])
  })
})
