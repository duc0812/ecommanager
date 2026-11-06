import { z } from 'zod'

export const DesignSchema = z.object({
  sourceGarment: z.string().min(1),
  base: z.string().min(1),
  front: z.string().min(1),
  back: z.string().nullable(),
  sleeves: z.string().nullable(),
  otherParts: z.string().nullable(),
  texts: z.array(z.object({ text: z.string().min(1), where: z.string().min(1) })),
})
export type Design = z.infer<typeof DesignSchema>

export const BlankDescriptionSchema = z.object({ blankDescription: z.string().min(1), unprintedParts: z.string() })
export type BlankDescription = z.infer<typeof BlankDescriptionSchema>

export type PromptTarget = { name: string; blankDescription: string; unprintedParts: string }

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()
const sentence = (s: string) => { const t = oneLine(s).replace(/[.;,]+$/, ''); return t ? `${t}.` : '' }
const quote = (s: string) => oneLine(s).replace(/'/g, '’')

export function renderPrintMapping(d: Design): string {
  const parts = [
    sentence(`Base print of the body and every other printed part: ${d.base}`),
    sentence(`Front view: ${d.front}`),
    d.back ? sentence(`Back view: ${d.back}`) : 'Back view: continues the same base pattern with no additional graphic.',
  ]
  if (d.sleeves) parts.push(sentence(`Sleeves: ${d.sleeves}`))
  if (d.otherParts) parts.push(sentence(`Other parts: ${d.otherParts}`))
  if (d.texts.length) {
    const list = d.texts.map(t => `the text '${quote(t.text)}' on ${oneLine(t.where).replace(/[.;,]+$/, '')}`).join(', ')
    parts.push(`Texts, each spelled exactly the same as in IMAGE 1: ${list}.`)
  }
  return parts.filter(Boolean).join(' ')
}

export function buildScalePrompt(target: PromptTarget, d: Design): string {
  const lines = [
    `IMAGE 2 is a blank ${oneLine(target.name)} mockup on a white background: ${sentence(target.blankDescription)}`,
    `Keep IMAGE 2 EXACTLY: same composition, same garment shapes, folds, construction details, camera angle and pure white background. Only replace the plain grey outer fabric with the all-over printed design from IMAGE 1 (a ${oneLine(d.sourceGarment)} mockup).`,
    'IMAGE 1 is the source of the artwork ONLY; ignore its garment shape, collar, trims, closures and background scene.',
    `Print mapping: ${renderPrintMapping(d)}`,
  ]
  const unprinted = oneLine(target.unprintedParts).replace(/[.;,]+$/, '')
  if (unprinted) lines.push(`${unprinted} stay unprinted.`)
  lines.push('Do not invent new graphics or text. Realistic printed fabric with natural folds and soft studio shadow, sharp high-resolution product photography, square 1:1.')
  return lines.join('\n')
}

export function designSystemPrompt(): string {
  return [
    'You prepare instructions for an image model that moves a printed design from one garment mockup onto a different blank garment.',
    'You are shown ONE image: a product mockup of a garment with a printed design. You are also told which garment the design will be moved onto and how that blank is laid out.',
    'Describe ONLY the printed artwork, area by area, precisely enough that someone who cannot see the image could place it on the new garment. Name colours. Name every figure, object and pattern in plain visual terms.',
    'Fields:',
    '- sourceGarment: the garment type in the image, 2-4 words, lowercase (e.g. "varsity jacket").',
    '- base: the ground colour and repeating background pattern that covers the body, hood exterior and back.',
    '- front: what is printed on the front and where it sits; say how it should sit on the target garment (e.g. split by a centre zipper, or kept on one front panel).',
    '- back: what is printed on the back and where. null when the image shows no back view. Never guess a back.',
    '- sleeves: what is printed on the sleeves (base colour, motifs, patches). null when sleeves just continue the base.',
    '- otherParts: print on a hood, collar, pockets or hem when it differs from the base; otherwise null.',
    '- texts: every word or number printed on the garment, exact spelling and capitalisation, one entry per text block, with where it sits (e.g. "the back, below the main graphic"). Signatures that cannot be read are not texts; mention them in front/back as "handwritten signatures". Empty array when there is no text.',
    'Do NOT describe: the garment shape, collar, ribbing stripes, buttons, zippers, the background scene, props, watermarks, store logos or neck labels of the source image. Trims of the source garment are dropped, not carried over.',
    'Write in English. Each field is one or two plain sentences without line breaks.',
  ].join('\n')
}

export function designUserText(target: { name: string; blankDescription: string }): string {
  return `Target garment: ${oneLine(target.name)}. Blank layout: ${oneLine(target.blankDescription)}\nDescribe the printed design of the attached image for that target.`
}

export function blankDescriptionSystemPrompt(): string {
  return [
    'You are shown a blank (unprinted, plain grey) garment mockup that will be used as the shape reference for an image model.',
    'Return two fields in English, no line breaks:',
    '- blankDescription: one to three sentences describing the layout and construction: which views are shown and where (e.g. "front view on the left with the zipper open showing the lining, back view on the right behind it"), closures, lining, hood, pockets, waistband, cuffs, and their colours.',
    '- unprintedParts: the parts that must stay unprinted because they are not sublimation fabric (ribbing, zipper, lining, drawstrings, buttons), written as a noun phrase starting with "The", e.g. "The ribbing, zipper and sherpa lining". Empty string when everything is printable.',
  ].join('\n')
}

export const MAKE_BLANK_PROMPT = [
  'Recreate this exact garment as a BLANK product mockup. Keep the same composition, the same camera angle, the same garment size and position in the frame, and the exact cut, folds, drape, proportions and construction details of the reference garment (closures, lining, hood, pockets, waistband, cuffs, collar).',
  'REMOVE ALL PRINTED ARTWORK: no graphics, no characters, no patterns, no stripes, no text, no logos, no labels.',
  'The entire outer fabric of the body, sleeves and hood exterior is ONE plain solid medium heather grey with no pattern at all, so it can be used later as a blank template. Unprinted trims (ribbing, zipper, lining, drawstrings, buttons) keep their own plain colours.',
  'The outer fabric is SMOOTH matte polyester like a sublimation-printed all-over-print garment: an even, clean surface with no bumpy, nubby, boucle, mottled or speckled texture; realism comes only from natural folds, seams and soft shadows.',
  'Replace the background with a pure white seamless studio background and a soft natural shadow under the garment. No props, no scene.',
  'Sharp high-resolution product photography, square 1:1.',
].join(' ')
