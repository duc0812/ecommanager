import { describe, it, expect } from 'vitest'
import { SHEET_PROMPT, blankDescriptionSystemPrompt, buildApplyPrompt } from '@/lib/scale/prompt'

const name = 'All-over Print Knitted Cardigan'
const both = { side: 'both' as const, blankDescription: 'front view at the upper left with an open V-neck and a button placket, back view at the lower right.', unprintedParts: 'The buttons, inner lining and neck label' }
const back = { side: 'back' as const, blankDescription: 'two back views of a man wearing the cloak', unprintedParts: '' }
const front = { side: 'front' as const, blankDescription: 'front view, zipper open.', unprintedParts: 'The zipper' }

describe('scale prompt', () => {
  it('step 1 asks for one flat pattern sheet with every captioned piece and nothing of the photo scene', () => {
    expect(SHEET_PROMPT).toContain('print-pattern layout')
    expect(SHEET_PROMPT).toContain('like a sewing pattern sheet')
    for (const piece of ['FRONT', 'LEFT FRONT and RIGHT FRONT', 'BACK', 'SLEEVE', 'HOOD']) expect(SHEET_PROMPT).toContain(piece)
    expect(SHEET_PROMPT).toContain('exactly as printed')
    expect(SHEET_PROMPT).toContain('When the photo does not show the back')
    expect(SHEET_PROMPT).not.toContain('\n')
  })

  it('step 2 on a two-view blank puts front pieces on the front view and the back piece on the back view', () => {
    const p = buildApplyPrompt(name, both)
    expect(p).toContain('IMAGE 1 is a flat print-pattern sheet')
    expect(p).toContain('IMAGE 2 is a blank All-over Print Knitted Cardigan mockup on a white background showing the FRONT and the BACK of the same garment: front view at the upper left')
    expect(p).toContain('Keep IMAGE 2 EXACTLY')
    expect(p).toContain('On each FRONT view: the FRONT piece covers the front body')
    expect(p).toContain('On each BACK view: the BACK piece covers the whole back')
    expect(p).toContain('Front artwork appears only on front views and back artwork only on back views')
    expect(p).toContain('The buttons, inner lining and neck label stay unprinted.')
    expect(p).toContain('The captions and the white page of the sheet are not part of the design')
    expect(p).toContain('do not invent new graphics or text')
  })

  it('a back-only blank gets the back piece only, a front-only blank the front pieces only', () => {
    const b = buildApplyPrompt('All-over Print Hooded Cloak Coat', back)
    expect(b).toContain('showing the BACK of the garment')
    expect(b).toContain('The BACK piece covers the whole back in every view shown. The FRONT pieces do not belong on this image.')
    expect(b).not.toContain('stay unprinted')
    const f = buildApplyPrompt(name, front)
    expect(f).toContain('showing the FRONT of the garment')
    expect(f).toContain('The BACK piece does not belong on this image.')
  })

  it('prints the whole outer fabric, ribbing and placket included, and keeps a model untouched', () => {
    const p = buildApplyPrompt(name, both)
    expect(p).not.toContain('grey')
    expect(p).toContain('printed edge to edge')
    expect(p).toContain('are not a design and must disappear completely')
    expect(p).toContain('Ribbed cuffs, hem or waistband, collar or neckband and the button placket are outer fabric too')
    expect(p).toContain('a person wearing it')
  })

  it('blank descriptions list ribbing as unprinted only when it is a different fixed colour', () => {
    const rule = blankDescriptionSystemPrompt()
    expect(rule).toContain('same placeholder colour as the rest of the outer fabric is printable and must NOT be listed')
    expect(rule).toContain('clearly a different fixed colour')
    expect(rule).toContain('the front, the back, or both views')
  })
})
