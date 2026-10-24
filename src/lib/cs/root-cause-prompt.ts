import type { CsCategory } from '@/lib/cs/triage'

export const STAGES = ['DESIGN', 'FULFILLMENT', 'FACTORY', 'CARRIER', 'CUSTOMER', 'LISTING', 'UNKNOWN'] as const
export const ISSUE_TYPES = ['WRONG_TEXT', 'WRONG_IMAGE', 'WRONG_SIZE_COLOR', 'PRINT_QUALITY', 'DAMAGED_IN_TRANSIT', 'LATE_DESIGN', 'LATE_HANDOFF', 'LATE_PRODUCTION', 'LATE_SHIPPING', 'LOST', 'NOT_AS_DESCRIBED', 'CUSTOMER_INPUT', 'OTHER'] as const
export type Stage = typeof STAGES[number]
export type IssueType = typeof ISSUE_TYPES[number]

export function buildRootCausePrompt(i: { thread: string; timeline: string; category: CsCategory; summary: string }): { system: string; user: string } {
  const system = `You investigate a customer complaint for Litzzy, a print-on-demand store, and decide which stage of our pipeline caused it. You are given the conversation and the order's real timeline from our system. Output JSON only.

## Stages
- DESIGN — our designer produced the print file: wrong text/image/colour in the approved file, or the design step took too long (gap "design" LATE).
- FULFILLMENT — our fulfillment team moved the order to the factory: sent the wrong or an old file, sent the wrong variant, or sat on a finished design (gap "handoff" LATE).
- FACTORY — the factory produced/shipped: printed differently from the approved file, print quality, wrong blank/size/colour, missing item, slow production (gap "production" LATE).
- CARRIER — in transit: damaged in transit, lost, stalled or very slow shipping (gaps "transit"/"stalled" LATE), delivered to the wrong place when the label was right.
- CUSTOMER — the customer's own input: typo in the personalisation they typed, wrong address they entered, ordered the wrong size/variant.
- LISTING — the product page set a wrong expectation (material, size, "3D"/embossed look, colours) and the item matches what we actually sell.
- UNKNOWN — the thread or the timeline does not contain the fact needed; never guess.

## Rules
1. "Late" is decided by the gap flags in the timeline (LATE markers), not by your own arithmetic. If no gap is LATE, do not pick a LATE_* issue type.
2. Wrong text/image: compare what the customer typed (customer typed …) with the approved print file / design note. Customer typed it wrong → CUSTOMER. Approved file wrong → DESIGN. Approved file right but the product is wrong → FACTORY. File sent to the factory differs from the approved file → FULFILLMENT.
3. Wrong address: the address in the order matches what the customer typed → CUSTOMER; our order shows a different address than the customer typed → FULFILLMENT; label right but parcel elsewhere → CARRIER.
4. If the timeline says "no design timeline", LATE_DESIGN and LATE_HANDOFF are impossible; split lateness between FACTORY and CARRIER using the production/transit gaps.
5. confidence: HIGH only when the deciding fact is in the thread or the timeline; MEDIUM when inferred from strong hints; LOW otherwise (and prefer UNKNOWN when nothing supports a stage).
6. evidence: Vietnamese, at most 3 short lines, quoting the timeline facts you relied on (dates, gaps, typed values).
7. affectedLineIds: the line ids (from "print file (…)" / "customer typed (…)" blocks) the complaint is about; empty when unclear.`
  const user = `# Complaint
category: ${i.category}
summary: ${i.summary}

# Order timeline
${i.timeline}

# Thread (oldest first)
${i.thread}`
  return { system, user }
}
