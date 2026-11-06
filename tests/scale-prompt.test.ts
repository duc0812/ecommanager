import { describe, it, expect } from 'vitest'
import { DesignSchema, buildMatchPrompt, buildViewPrompt, designSystemPrompt, renderPrintMapping, type Design } from '@/lib/scale/prompt'

const front = { side: 'front' as const, blankDescription: 'unworn zip hoodie, front view, zipper open showing the white sherpa lining.', unprintedParts: 'The ribbing, zipper and sherpa lining' }
const back = { side: 'back' as const, blankDescription: 'unworn zip hoodie, back view, hood down.', unprintedParts: '' }
const name = 'All-over Print Fleece Zip Hoodie'
const design: Design = {
  sourceGarment: 'varsity jacket',
  base: 'black with small yellow-green sparkles and orange clouds',
  front: 'an armored figure on a hill in front of a large orange sun',
  back: 'a large poster graphic centered on the back panel',
  sleeves: 'cream base with orange clouds',
  otherParts: null,
  texts: [
    { text: 'CELEBRATION', where: 'on the lower front', side: 'front' },
    { text: 'STAR WARS DAY', where: 'the back', side: 'back' },
    { text: 'STAR WARS', where: 'On each upper sleeve.', side: 'sleeve' },
  ],
}

describe('scale prompt', () => {
  it('a front view gets the front artwork and front texts only', () => {
    const p = buildViewPrompt(name, front, design)
    expect(p).toContain('IMAGE 2 is a blank All-over Print Fleece Zip Hoodie mockup on a white background showing the FRONT of the garment: unworn zip hoodie, front view')
    expect(p).toContain('Keep IMAGE 2 EXACTLY')
    expect(p).toContain('from IMAGE 1 (a varsity jacket mockup)')
    expect(p).toContain('IMAGE 1 is the source of the artwork ONLY')
    expect(p).toContain('Use only the FRONT artwork of IMAGE 1')
    expect(p).toContain('an armored figure on a hill')
    expect(p).not.toContain('a large poster graphic')
    expect(p).toContain("the text 'CELEBRATION' on the lower front")
    expect(p).toContain("the text 'STAR WARS' on each upper sleeve")
    expect(p).not.toContain('STAR WARS DAY')
    expect(p).toContain('spelled exactly the same')
    expect(p).toContain('The ribbing, zipper and sherpa lining stay unprinted.')
    expect(p).toContain('Do not invent new graphics or text.')
  })

  it('a back view gets the back artwork and back texts only', () => {
    const p = buildViewPrompt(name, back, design)
    expect(p).toContain('showing the BACK of the garment')
    expect(p).toContain('Use only the BACK artwork of IMAGE 1')
    expect(p).toContain('a large poster graphic')
    expect(p).not.toContain('an armored figure on a hill')
    expect(p).toContain("the text 'STAR WARS DAY' on the back")
    expect(p).not.toContain('CELEBRATION')
    expect(p).not.toContain('stay unprinted')
  })

  it('does not invent a back graphic when the source shows no back', () => {
    const p = buildViewPrompt(name, back, { ...design, back: null, texts: [] })
    expect(p).toContain('Back view: continues the same base pattern with no additional graphic.')
    expect(p).not.toContain('spelled exactly')
  })

  it('prints the whole outer fabric: no placeholder colour and no bare patch may remain', () => {
    const p = buildViewPrompt(name, back, design)
    expect(p).not.toContain('grey')
    expect(p).toContain('placeholder colour or colour blocks are not a design and must disappear completely')
    expect(p).toContain('printed edge to edge')
    expect(p).toContain('a person wearing it')
  })

  it('a second view of the same side copies the finished first view instead of reading the source again', () => {
    const p = buildMatchPrompt(name, back)
    expect(p).toContain('IMAGE 1 is a finished mockup of this same printed garment')
    expect(p).toContain('showing the BACK of the garment: unworn zip hoodie, back view')
    expect(p).toContain('exactly the same printed design')
    expect(p).toContain('printed edge to edge')
  })

  it('keeps model text on one line and does not double the preposition', () => {
    const m = renderPrintMapping({ ...design, front: 'line one\nline two' }, 'front')
    expect(m).not.toContain('\n')
    expect(m.toLowerCase()).not.toContain('on on ')
  })

  it('asks for figures to be described by what they look like, the way the hand-written prompts did', () => {
    const p = designSystemPrompt()
    expect(p).toContain('by what it looks like')
    expect(p).toContain('never by the name of a character, a franchise, a brand or a real person')
    expect(p).toContain('Printed words are different')
  })

  it('rejects a design without sourceGarment or a text without a side', () => {
    expect(DesignSchema.safeParse({ ...design, sourceGarment: undefined }).success).toBe(false)
    expect(DesignSchema.safeParse({ ...design, texts: [{ text: 'A', where: 'the back' }] }).success).toBe(false)
  })
})
