import { describe, it, expect } from 'vitest'
import { timeLeft, allSlotsFilled, taskImages, canRemoveArtwork, canMove, retryDelay, isRetryable, emptyQueueText } from '@/app/design-studio/components/model'

const NOW = Date.parse('2026-10-10T12:00:00Z')

describe('timeLeft', () => {
  it('never reports time left for a past due date', () => {
    expect(timeLeft({ status: 'DOING', dueAt: new Date(NOW - 10 * 60_000).toISOString() }, NOW)).toMatchObject({ label: 'quá 0h', tone: 'bad' })
    expect(timeLeft({ status: 'DOING', dueAt: new Date(NOW - 3.5 * 3.6e6).toISOString() }, NOW)).toMatchObject({ label: 'quá 3h', tone: 'bad' })
  })
  it('floors the remaining hours and warns at 4h or less', () => {
    expect(timeLeft({ status: 'DOING', dueAt: new Date(NOW + 3.9 * 3.6e6).toISOString() }, NOW)).toMatchObject({ label: 'còn 3h', tone: 'warn' })
    expect(timeLeft({ status: 'DOING', dueAt: new Date(NOW + 30 * 3.6e6).toISOString() }, NOW)).toMatchObject({ label: 'còn 30h', tone: 'idle' })
  })
})

describe('allSlotsFilled', () => {
  const art = (printArea: string) => ({ printArea } as any)
  it('checks exactly the slots the server requires', () => {
    expect(allSlotsFilled({ slots: ['Front', 'Back'], line: { artworks: [art('Front')] } as any })).toBe(false)
    expect(allSlotsFilled({ slots: ['Front', 'Back'], line: { artworks: [art('Front'), art('Back')] } as any })).toBe(true)
    expect(allSlotsFilled({ slots: ['Front'], line: { artworks: [art('Front'), art('PRINT')] } as any })).toBe(true)
  })
})

describe('taskImages', () => {
  const art = (id: string, printArea: string, version: number, mimeType = 'image/png') =>
    ({ id, printArea, version, fileName: `${id}.png`, mimeType, url: `/api/design-studio/file/${id}`, driveWebViewLink: null } as any)
  it('lists preview, variant, newest artwork per area, older versions and source files once each', () => {
    const line = {
      previewUrl: 'https://cdn/p.png', imageUrl: 'https://cdn/v.png',
      artworks: [art('a1', 'Front', 1), art('a2', 'Front', 2), art('b1', 'Back', 1), art('psd', 'Back', 2, 'image/vnd.adobe.photoshop')],
      sourcePrintFiles: [{ printArea: 'Print', url: 'https://cdn/s.png' }, { printArea: 'Dup', url: 'https://cdn/p.png' }],
    } as any
    expect(taskImages({ line }).map(m => m.url)).toEqual([
      'https://cdn/p.png', 'https://cdn/v.png', '/api/design-studio/file/a2', '/api/design-studio/file/b1', '/api/design-studio/file/a1', 'https://cdn/s.png',
    ])
  })
})

describe('canRemoveArtwork', () => {
  it('allows the uploader or an admin until the task is DONE', () => {
    expect(canRemoveArtwork({ uploadedById: 'u1' }, { id: 'u1', role: 'SUPPORT' }, 'DOING').ok).toBe(true)
    expect(canRemoveArtwork({ uploadedById: 'u1' }, { id: 'u2', role: 'SUPPORT' }, 'DOING').ok).toBe(false)
    expect(canRemoveArtwork({ uploadedById: null }, { id: 'u2', role: 'ADMIN' }, 'REVIEW').ok).toBe(true)
    expect(canRemoveArtwork({ uploadedById: 'u1' }, { id: 'u1', role: 'SUPERADMIN' }, 'DONE').ok).toBe(false)
  })
})

describe('canMove', () => {
  const detail = (status: string, isLeader: boolean, canApprove = isLeader, assigneeId: string | null = null) => ({
    task: { status, readiness: 'AUTO', assigneeId } as any,
    me: { id: 'u', name: 'U', role: isLeader ? 'ADMIN' : 'SUPPORT', isLeader, canApprove, canHandoff: isLeader },
  })
  it('without the approve capability a designer waits for a leader', () => {
    expect(canMove(detail('REVIEW', false), 'DONE')).toBe(false)
    expect(canMove(detail('REVIEW', false), 'REJECTED')).toBe(false)
    expect(canMove(detail('DOING', false), 'REVIEW')).toBe(true)
    expect(canMove(detail('REVIEW', true), 'DONE')).toBe(true)
  })
  it('with the approve capability a designer approves or returns any REVIEW task, but never skips REVIEW', () => {
    expect(canMove(detail('REVIEW', false, true), 'DONE')).toBe(true)
    expect(canMove(detail('REVIEW', false, true), 'REJECTED')).toBe(true)
    expect(canMove(detail('REVIEW', false, true, 'someone-else'), 'DONE')).toBe(true)
    expect(canMove(detail('DOING', false, true), 'DONE')).toBe(false)
    expect(canMove(detail('NEW', false, true), 'DONE')).toBe(false)
    expect(canMove(detail('ASSIGNED', false, true), 'DONE')).toBe(false)
    expect(canMove(detail('NEW', false, true), 'ASSIGNED')).toBe(false)
  })
})

describe('queue retry and empty state', () => {
  it('backs off 2s, 5s, 10s, then every 30s', () => {
    expect([0, 1, 2, 3, 4, 9].map(retryDelay)).toEqual([2000, 5000, 10000, 30000, 30000, 30000])
  })
  it('retries only when the server was unreachable or failed', () => {
    expect(isRetryable(0)).toBe(true)
    expect(isRetryable(502)).toBe(true)
    expect(isRetryable(401)).toBe(false)
    expect(isRetryable(403)).toBe(false)
  })
  it('names the filter that emptied the list', () => {
    expect(emptyQueueText({ readinessLabel: 'Tự động đạt', mine: true, q: '' })).toBe("Không có task 'Tự động đạt' của bạn")
    expect(emptyQueueText({ readinessLabel: null, mine: false, q: 'LIT1' })).toBe('Không có task khớp "LIT1"')
  })
})
