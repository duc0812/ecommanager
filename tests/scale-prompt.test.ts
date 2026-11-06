import { describe, it, expect } from 'vitest'
import { DesignSchema, MAKE_BLANK_PROMPT, buildScalePrompt, renderPrintMapping, type Design } from '@/lib/scale/prompt'

const target = { name: 'All-over Print Fleece Zip Hoodie', blankDescription: 'front view on the left with the zipper open showing the white sherpa lining, back view on the right.', unprintedParts: 'The ribbing, zipper and sherpa lining' }
const design: Design = {
  sourceGarment: 'varsity jacket',
  base: 'black with small yellow-green sparkles and orange clouds',
  front: 'an armored figure on a hill in front of a large orange sun',
  back: 'a large poster graphic centered on the back panel',
  sleeves: 'cream base with orange clouds',
  otherParts: null,
  texts: [{ text: 'STAR WARS DAY', where: 'the back' }, { text: '2026', where: 'the back' }],
}

describe('scale prompt', () => {
  it('fills the frame with target, design and unprinted parts', () => {
    const p = buildScalePrompt(target, design)
    expect(p).toContain('IMAGE 2 is a blank All-over Print Fleece Zip Hoodie mockup on a white background: front view on the left')
    expect(p).toContain('Keep IMAGE 2 EXACTLY')
    expect(p).toContain('from IMAGE 1 (a varsity jacket mockup)')
    expect(p).toContain('IMAGE 1 is the source of the artwork ONLY')
    expect(p).toContain("the text 'STAR WARS DAY' on the back")
    expect(p).toContain('spelled exactly the same')
    expect(p).toContain('The ribbing, zipper and sherpa lining stay unprinted.')
    expect(p).toContain('Do not invent new graphics or text.')
  })

  it('does not invent a back graphic when the source shows no back', () => {
    const p = buildScalePrompt(target, { ...design, back: null, texts: [] })
    expect(p).toContain('Back view: continues the same base pattern with no additional graphic.')
    expect(p).not.toContain('spelled exactly')
  })

  it('drops the unprinted line when the target has none', () => {
    expect(buildScalePrompt({ ...target, unprintedParts: '' }, design)).not.toContain('stay unprinted')
  })

  it('strips line breaks from model text so the mapping stays one paragraph', () => {
    expect(renderPrintMapping({ ...design, front: 'line one\nline two' })).not.toContain('\n')
  })

  it('rejects a design without sourceGarment', () => {
    expect(DesignSchema.safeParse({ ...design, sourceGarment: undefined }).success).toBe(false)
  })

  it('asks the blank prompt for a plain grey garment on white', () => {
    expect(MAKE_BLANK_PROMPT).toContain('REMOVE ALL PRINTED ARTWORK')
    expect(MAKE_BLANK_PROMPT).toContain('pure white')
  })
})
