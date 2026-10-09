import { describe, it, expect } from 'vitest'
import { timeLeft, allSlotsFilled, taskImages, canRemoveArtwork } from '@/app/design-studio/components/model'

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
