import { z } from 'zod'

export const VIEW_SIDES = ['front', 'back'] as const
export type ViewSide = (typeof VIEW_SIDES)[number]

export const DesignSchema = z.object({
  sourceGarment: z.string().min(1),
  base: z.string().min(1),
  front: z.string().min(1),
  back: z.string().nullable(),
  sleeves: z.string().nullable(),
  otherParts: z.string().nullable(),
  texts: z.array(z.object({ text: z.string().min(1), where: z.string().min(1), side: z.enum(['front', 'back', 'sleeve', 'other']) })),
})
export type Design = z.infer<typeof DesignSchema>

export const BlankDescriptionSchema = z.object({ blankDescription: z.string().min(1), unprintedParts: z.string() })
export type BlankDescription = z.infer<typeof BlankDescriptionSchema>

export type PromptView = { side: ViewSide; blankDescription: string; unprintedParts: string }

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()
const sentence = (s: string) => { const t = oneLine(s).replace(/[.;,]+$/, ''); return t ? `${t}.` : '' }
const place = (s: string) => { const t = oneLine(s).replace(/[.;,]+$/, '').replace(/^on\s+/i, ''); return t.charAt(0).toLowerCase() + t.slice(1) }
const quote = (s: string) => oneLine(s).replace(/'/g, '’')

export function renderPrintMapping(d: Design, side: ViewSide): string {
  const parts = [sentence(`Base print of the body and every other printed part: ${d.base}`)]
  if (side === 'front') parts.push(sentence(`Front view: ${d.front}`))
  else parts.push(d.back ? sentence(`Back view: ${d.back}`) : 'Back view: continues the same base pattern with no additional graphic.')
  if (d.sleeves) parts.push(sentence(`Sleeves: ${d.sleeves}`))
  if (d.otherParts) parts.push(sentence(`Other parts: ${d.otherParts}`))
  const texts = d.texts.filter(t => t.side === side || t.side === 'sleeve' || t.side === 'other')
  if (texts.length) {
    const list = texts.map(t => `the text '${quote(t.text)}' on ${place(t.where)}`).join(', ')
    parts.push(`Texts, each spelled exactly the same as in IMAGE 1: ${list}.`)
  }
  return parts.filter(Boolean).join(' ')
}

const KEEP = 'Keep IMAGE 2 EXACTLY: same composition, same garment shapes, folds, construction details, camera angle and pure white background.'
const FULL_PRINT = 'Every part of the outer fabric visible in IMAGE 2 is printed edge to edge, up to every seam and hem: its placeholder colour or colour blocks are not a design and must disappear completely, and no bare, white or single-coloured patch of outer fabric may remain. Ribbed cuffs, hem or waistband, collar or neckband and the button placket are outer fabric too: unless they are listed below as unprinted, the design continues onto them, with no plain band left.'
const UNTOUCHED = 'Everything else in IMAGE 2 stays untouched: a person wearing it, their face, hair, hands and other clothing, and every trim.'
const FINISH = 'Do not invent new graphics or text. Realistic printed fabric with natural folds and soft studio shadow, sharp high-resolution product photography.'

function blankLine(name: string, view: PromptView) {
  return `IMAGE 2 is a blank ${oneLine(name)} mockup on a white background showing the ${view.side.toUpperCase()} of the garment: ${sentence(view.blankDescription)}`
}

function unprintedLine(view: PromptView): string[] {
  const unprinted = oneLine(view.unprintedParts).replace(/[.;,]+$/, '')
  return unprinted ? [`${unprinted} stay unprinted.`] : []
}

export function buildViewPrompt(name: string, view: PromptView, d: Design): string {
  const side = view.side.toUpperCase()
  const other = view.side === 'front' ? 'BACK' : 'FRONT'
  return [
    blankLine(name, view),
    `${KEEP} Only replace the unprinted outer fabric of the garment with the all-over printed design from IMAGE 1 (a ${oneLine(d.sourceGarment)} mockup). ${FULL_PRINT} ${UNTOUCHED}`,
    `IMAGE 1 is the source of the artwork ONLY; ignore its garment shape, collar, trims, closures and background scene. Use only the ${side} artwork of IMAGE 1; the ${other} artwork does not belong on this view.`,
    `Print mapping: ${renderPrintMapping(d, view.side)}`,
    ...unprintedLine(view),
    FINISH,
  ].join('\n')
}

export function buildMatchPrompt(name: string, view: PromptView): string {
  return [
    `IMAGE 1 is a finished mockup of this same printed garment seen from another angle. ${blankLine(name, view)}`,
    `${KEEP} Only replace the unprinted outer fabric of the garment in IMAGE 2 with exactly the same printed design that the garment wears in IMAGE 1: same artwork, same colours, same texts with the same spelling, each element on the same part of the garment, adjusted only for this view's angle and folds. ${FULL_PRINT} ${UNTOUCHED}`,
    ...unprintedLine(view),
    FINISH,
  ].join('\n')
}

export function designSystemPrompt(): string {
  return [
    'You prepare instructions for an image model that moves a printed design from one garment mockup onto a different blank garment, one view (front or back) at a time.',
    'You are shown ONE image: a product mockup of a garment with a printed design. You are also told which garment the design will be moved onto.',
    'Describe ONLY the printed artwork, area by area, precisely enough that someone who cannot see the image could place it on the new garment. Name colours. Describe every figure, object and pattern by what it looks like (shape, colours, clothing, pose), never by the name of a character, a franchise, a brand or a real person. Printed words are different: any text printed on the garment still goes into texts with its exact spelling.',
    'Fields:',
    '- sourceGarment: the garment type in the image, 2-4 words, lowercase (e.g. "varsity jacket").',
    '- base: the ground colour and repeating background pattern that covers the body, hood exterior and back.',
    '- front: what is printed on the FRONT of the garment and where it sits. Describe only front artwork here.',
    '- back: what is printed on the BACK of the garment and where. null when the image shows no back view. Never guess a back. Describe only back artwork here.',
    '- sleeves: what is printed on the sleeves (base colour, motifs, patches). null when sleeves just continue the base.',
    '- otherParts: print on a hood, collar, pockets or hem when it differs from the base; otherwise null.',
    '- texts: every word or number printed on the garment, exact spelling and capitalisation, one entry per text block, with where it sits and side = "front", "back", "sleeve" or "other" (hood, collar, pocket). Signatures that cannot be read are not texts; mention them in front/back as "handwritten signatures". Empty array when there is no text.',
    'Do NOT describe: the garment shape, collar, ribbing stripes, buttons, zippers, the background scene, props, watermarks, store logos or neck labels of the source image. Trims of the source garment are dropped, not carried over.',
    'Write in English. Each field is one or two plain sentences without line breaks.',
  ].join('\n')
}

export function designUserText(targetName: string): string {
  return `Target garment: ${oneLine(targetName)}.\nDescribe the printed design of the attached image for that target.`
}

export function blankDescriptionSystemPrompt(): string {
  return [
    'You are shown a blank (unprinted) garment mockup that will be used as the shape reference for an image model. It shows ONE view of the garment (you are told whether it is the front or the back). It may be a flat product shot or worn by a model. The outer fabric is shown plain white or grey, in one placeholder colour, or in placeholder colour blocks. Those colours are NOT a design.',
    'Return two fields in English, no line breaks:',
    '- blankDescription: one to three sentences describing the view and the construction: whether a model is wearing it, the angle and pose, closures, lining, hood, pockets, waistband, cuffs, and which parts of the outer fabric are visible. Do not name the placeholder colour of the outer fabric.',
    '- unprintedParts: the parts that must stay unprinted, written as a noun phrase starting with "The", e.g. "The zipper, drawstrings and sherpa lining". These garments are all-over print: ribbing (cuffs, hem band, waistband, collar, neckband, button placket) shown in the same placeholder colour as the rest of the outer fabric is printable and must NOT be listed. List ribbing only when it is clearly a different fixed colour from the outer fabric (for example black ribbing on a light garment). Always list hardware and lining: zipper, buttons or snaps, toggles, drawstring cords, eyelets, lining, neck label. Empty string when everything is printable.',
  ].join('\n')
}
