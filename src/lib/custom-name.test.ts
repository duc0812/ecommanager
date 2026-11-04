import { describe, expect, it } from 'vitest'
import { customNameOf } from '@/lib/custom-name'

const f = (...pairs: [string, string][]) => pairs.map(([key, value]) => ({ key, value }))

describe('customNameOf', () => {
  it('keeps only the name of LIT6023_1', () => {
    expect(customNameOf(f(['Choose Color', 'download - 2026-10-23T174046.722'], ['Custom Name Yes Or No', 'Yes'], ['Custom Name', 'Salty Daze']))).toBe('Salty Daze')
  })

  it('joins several printed fields like the team does', () => {
    expect(customNameOf(f(['Choose Back Dessign', 'Yes'], ['Enter Name', 'Lake'], ['Enter Name or Enter Number', 'Lake'], ['Enter Number', '21']))).toBe('Lake / Lake / 21')
  })

  it('reads the other spellings of the field', () => {
    expect(customNameOf(f(['YOUR NAME', 'Susan '], ['Custom Name/Text', 'Beckie']))).toBe('Susan / Beckie')
    expect(customNameOf(f(['Enter Your Personalization', 'Deborah']))).toBe('Deborah')
  })

  it('keeps a number, even zero', () => {
    expect(customNameOf(f(['Custom Number', '0']))).toBe('0')
  })

  it('leaves out answers, picture choices and uploads', () => {
    expect(customNameOf(f(['Custom Name:', 'No']))).toBe('')
    expect(customNameOf(f(['Custom Name: Yes or No?', '1']))).toBe('')
    expect(customNameOf(f(['Choose Your House', 'download - 2026-10-21T142720.528']))).toBe('')
    expect(customNameOf(f(['Choose Color', 'Image 2'], ['Layer _0ixi8', 'LkGMJfbja'], ['Upload Your Jeep Photo', 'https://cdn.shopify.com/x.png']))).toBe('')
  })

  it('has nothing to say on a line with no fields', () => {
    expect(customNameOf([])).toBe('')
  })
})
