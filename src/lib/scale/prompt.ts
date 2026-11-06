import { z } from 'zod'

export const VIEW_SIDES = ['both', 'front', 'back'] as const
export type ViewSide = (typeof VIEW_SIDES)[number]

export const BlankDescriptionSchema = z.object({ blankDescription: z.string().min(1), unprintedParts: z.string() })
export type BlankDescription = z.infer<typeof BlankDescriptionSchema>

export type PromptView = { side: ViewSide; blankDescription: string; unprintedParts: string }

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()
const sentence = (s: string) => { const t = oneLine(s).replace(/[.;,]+$/, ''); return t ? `${t}.` : '' }

// Step 1: the source photo becomes one flat sheet with every cut piece of the print, captioned.
export const SHEET_PROMPT = [
  'This photo shows a printed garment, usually from the front and from the back.',
  'Make a technical print-pattern layout of its fabric print on one white page: the cut pieces laid flat and separate, like a sewing pattern sheet.',
  'Pieces, each with a small black caption: FRONT (the front body; when the garment opens down the front, show its two front panels side by side, captioned LEFT FRONT and RIGHT FRONT), BACK (one large panel), SLEEVE (one sleeve piece) and, only when the garment has a hood, HOOD (one hood piece).',
  'Every piece is a flat shape filled completely with the fabric print of that part, exactly as printed: same graphics, same colours, same lettering, same placement.',
  'When the photo does not show the back, the BACK piece continues the base colour and background pattern of the front with no extra graphic.',
  'No folds, no shading, no garment worn or hanging, no lining, no zipper teeth, no scene. Flat, even lighting, sharp detail.',
].join(' ')

const KEEP = 'Keep IMAGE 2 EXACTLY: same composition, every garment in the same position, same garment shapes, folds, construction details, camera angle and pure white background.'
const FULL_PRINT = 'Every part of the outer fabric is printed edge to edge, up to every seam and hem: the placeholder colour or colour blocks of IMAGE 2 are not a design and must disappear completely, and no bare, white or single-coloured patch of outer fabric may remain. Ribbed cuffs, hem or waistband, collar or neckband and the button placket are outer fabric too: unless they are listed below as unprinted, the design continues onto them, with no plain band left.'
const UNTOUCHED = 'Everything else in IMAGE 2 stays untouched: a person wearing it, their face, hair, hands and other clothing, and every trim.'
const FINISH = 'The captions and the white page of the sheet are not part of the design and must not appear. Keep every graphic, colour and lettering of the pieces, each text spelled exactly the same; do not invent new graphics or text. Realistic printed fabric with natural folds and soft studio shadow, sharp high-resolution product photography.'

const PLACEMENT: Record<ViewSide, string> = {
  both: 'On each FRONT view: the FRONT piece covers the front body (when the sheet has LEFT FRONT and RIGHT FRONT pieces, each covers its own side of the front opening). On each BACK view: the BACK piece covers the whole back. Front artwork appears only on front views and back artwork only on back views.',
  front: 'The FRONT piece covers the front body (when the sheet has LEFT FRONT and RIGHT FRONT pieces, each covers its own side of the front opening). The BACK piece does not belong on this image.',
  back: 'The BACK piece covers the whole back in every view shown. The FRONT pieces do not belong on this image.',
}
const SHOWS: Record<ViewSide, string> = {
  both: 'showing the FRONT and the BACK of the same garment',
  front: 'showing the FRONT of the garment',
  back: 'showing the BACK of the garment',
}

// Step 2: the sheet is printed onto the blank of the target product.
export function buildApplyPrompt(name: string, view: PromptView): string {
  const unprinted = oneLine(view.unprintedParts).replace(/[.;,]+$/, '')
  return [
    'IMAGE 1 is a flat print-pattern sheet of one all-over print design: captioned flat pieces such as FRONT (or LEFT FRONT and RIGHT FRONT), BACK, SLEEVE and sometimes HOOD.',
    `IMAGE 2 is a blank ${oneLine(name)} mockup on a white background ${SHOWS[view.side]}: ${sentence(view.blankDescription)}`,
    `${KEEP} Print the design of IMAGE 1 onto the outer fabric of the garment in IMAGE 2, each piece scaled to fit its part and following the folds naturally. ${PLACEMENT[view.side]} The SLEEVE piece goes on the sleeves; the HOOD piece goes on the hood when the garment has one and is ignored otherwise.`,
    `${FULL_PRINT} ${UNTOUCHED}`,
    ...(unprinted ? [`${unprinted} stay unprinted.`] : []),
    FINISH,
  ].join('\n')
}

export function blankDescriptionSystemPrompt(): string {
  return [
    'You are shown a blank (unprinted) garment mockup that will be used as the shape reference for an image model. It shows the front, the back, or both views of one garment (you are told which). It may be a flat product shot or worn by a model. The outer fabric is shown plain white or grey, in one placeholder colour, or in placeholder colour blocks. Those colours are NOT a design.',
    'Return two fields in English, no line breaks:',
    '- blankDescription: one to three sentences describing which views are shown and where they sit in the image, whether a model is wearing it, the angle and pose, closures, lining, hood, pockets, waistband, cuffs, and which parts of the outer fabric are visible. Do not name the placeholder colour of the outer fabric.',
    '- unprintedParts: the parts that must stay unprinted, written as a noun phrase starting with "The", e.g. "The zipper, drawstrings and sherpa lining". These garments are all-over print: ribbing (cuffs, hem band, waistband, collar, neckband, button placket) shown in the same placeholder colour as the rest of the outer fabric is printable and must NOT be listed. List ribbing only when it is clearly a different fixed colour from the outer fabric (for example black ribbing on a light garment). Always list hardware and lining: zipper, buttons or snaps, toggles, drawstring cords, eyelets, lining, neck label. Empty string when everything is printable.',
  ].join('\n')
}
