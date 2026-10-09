import { describe, it, expect } from 'vitest'
import { timeLeft, allSlotsFilled } from '@/app/design-studio/components/model'

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
