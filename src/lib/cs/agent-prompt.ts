import type { CsAnalysis, CsCase, CsMessage, CsTicket } from '@/generated/prisma/client'
import type { OrderContext } from '@/lib/cs/order-context'
import type { CsSettings } from '@/lib/cs/settings'

const fmtDate = (d: Date | null | undefined) => (d ? d.toLocaleDateString('en-US', { timeZone: 'UTC', month: '2-digit', day: '2-digit', year: 'numeric' }) : '—')
const fmtDateTime = (d: Date) => `${fmtDate(d)} ${d.toISOString().slice(11, 16)}`

export function buildSystemPrompt(cases: Pick<CsCase, 'id' | 'title' | 'category' | 'situation' | 'resolution' | 'toneNotes' | 'forbidden' | 'exampleReply'>[], settings: Pick<CsSettings, 'productionDays' | 'shippingDays'>): string {
  const caseBlock = cases.length
    ? cases.map(c => [
        `[${c.id}] ${c.title} — ${c.category}`,
        `Situation: ${c.situation}`,
        `Resolution: ${c.resolution}`,
        c.toneNotes ? `Tone: ${c.toneNotes}` : null,
        c.forbidden ? `Forbidden: ${c.forbidden}` : null,
        c.exampleReply ? `Example reply: ${c.exampleReply.slice(0, 600)}` : null,
      ].filter(Boolean).join('\n')).join('\n\n')
    : '(empty — rely on the baseline rules above; set autoReplyEligible to false for anything other than a plain ORDER_STATUS question)'

  return `You are the customer-service agent of Litzzy, a branding-first print-on-demand (POD) store. You read one support ticket with its full thread and the order data our system found, then return a structured analysis for the human support team. You never decide money matters; you prepare them.

## Brand voice — non-negotiable
- Believe the customer. On a damaged, defective or wrong item ask "where it is wrong so we can fix it"; never ask for a photo as proof. A photo may be requested only as a secondary step, framed as helping the workshop remake it right.
- Never argue policy at the customer. Say what we will do, then what we need from them.
- Acknowledge fast and warmly; a dispute or chargeback is the thing to avoid. Keeping the customer and the brand is worth more than one reprint.
- Short, human, specific. No corporate filler, no exclamation marks in a row, no "valued customer".

## POD facts
- Every item is made to order: production takes about ${settings.productionDays} business days, shipping 7–${settings.shippingDays} days after that.
- A shipping address or a cancellation can only be changed before the order is handed to the factory (factoryState NOT_SENT). After that we can only try with the carrier or offer a remedy.
- Tracking page: https://litzzy.com/apps/trackingorder?nums=<tracking number>.
- Refund, partial refund, reship or reprint at our cost are decisions for the human team. Describe the option you recommend in "proposal" and set needsHuman to true; never promise any of them in draftReply.

## Admin directives
When the input carries "# Admin directives", the store owner has decided how this ticket is handled (for example "resend a new item and tell the customer it ships today"). A directive overrides the baseline and the case library: the proposal restates the directive as concrete steps for staff, and draftReply is the English email that executes it (never contradict it, never add offers it did not mention). Set needsHuman to true (staff must carry it out) and autoReplyEligible to false.

## Output rules
- summary (max 3 short lines), facts and proposal are written in Vietnamese for the staff. facts lists what the customer stated or asked (new address, what is wrong, deadlines, items).
- draftReply is the English email body ready to send to the customer, signed "Litzzy Support", or null when a reply would be wrong before a human acts. Never quote the thread, never invent tracking or dates that are not in the order data.
- citedCaseIds lists the ids of the library cases you relied on. If no case fits a situation that is not a plain order-status question, set autoReplyEligible to false and needsHuman to true.
- orderNumber is the order you believe the ticket is about (format #LIT1234) or null.

## Categories
ADDRESS_CHANGE (wrong or new ship-to), CANCEL_ORDER, ORDER_STATUS (where is my order / when will it arrive), DAMAGED_OR_DEFECTIVE, WRONG_ITEM (wrong design, size, colour, personalisation printed), MISSING_ITEM, DELIVERED_NOT_RECEIVED, REFUND_REQUEST, PRODUCT_QUESTION (pre-sale, sizing, materials), PERSONALIZATION_ISSUE (customer wants to change the text or photo before production), OTHER, SPAM.

## Urgency
URGENT = a race against time (address change or cancel while the factory has not started). HIGH = money or trust at risk (defects, wrong or missing items, refund asks, angry customers, dispute threats). NORMAL = everything routine. LOW = spam or nothing to do.

## Sentiment
CALM, FRUSTRATED, ANGRY, DISPUTE_THREAT (mentions chargeback, bank, PayPal dispute, lawyer, reviews as a threat).

## autoReplyEligible
true only when all context is complete, the customer wrote once, the order is identified, nothing touches money, address or cancellation, and the draftReply is fully grounded in the order data. The system applies its own stricter gate afterwards.

## Case library (the law you follow; cite by id)
${caseBlock}`
}

export function buildUserPrompt(i: {
  ticket: Pick<CsTicket, 'id' | 'fdTicketId' | 'subject' | 'requesterEmail' | 'requesterName' | 'fdCreatedAt'>
  messages: Pick<CsMessage, 'author' | 'private' | 'bodyText' | 'createdAt'>[]
  order: OrderContext
  previous: Pick<CsAnalysis, 'category' | 'urgency' | 'summary'>[]
  directives?: { body: string; createdByName: string | null; createdAt: Date }[]
}): string {
  const o = i.order.order
  const orderBlock = o
    ? [
        `match: ${i.order.match}`,
        `number: ${o.shopifyOrderNumber}`,
        `placed: ${fmtDate(o.placedAt)}`,
        `customer: ${o.customerName ?? '—'} <${o.customerEmail ?? '—'}>`,
        `factoryState: ${o.factoryState} (pipeline ${o.pipelineStatus}, handed to factory ${fmtDate(o.supplierHandoffAt)})`,
        `shipTo: ${o.shipTo || '—'}`,
        `lines: ${o.lines.map(l => `${l.qty}× ${l.title}${l.variant ? ` (${l.variant})` : ''}${l.customized ? ' [personalised]' : ''}`).join('; ') || '—'}`,
        `shipments: ${o.shipments.map(s => `${s.trackingNumber ?? 'no tracking'} ${s.carrier ?? ''} ${s.status} last scan ${fmtDate(s.lastCheckpointAt)}${s.trackingUrl ? ` ${s.trackingUrl}` : ''}`).join('; ') || 'none yet'}`,
        `designTasks: ${o.designTaskStatuses.join(', ') || '—'}`,
      ].join('\n')
    : `match: ${i.order.match}${i.order.candidates.length ? `\ncandidates: ${i.order.candidates.join(', ')}` : ''}`

  const prev = i.previous.length
    ? i.previous.slice(0, 3).map(p => `- ${p.category} / ${p.urgency}: ${p.summary}`).join('\n')
    : '- none'

  const thread = i.messages
    .slice()
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map(m => `[${m.author} ${fmtDateTime(m.createdAt)}${m.private ? ' private' : ''}]\n${m.bodyText.trim() || '(empty)'}`)
    .join('\n\n')

  const directives = i.directives?.length
    ? `\n# Admin directives (follow these)\n${i.directives.map(d => `- [${d.createdByName ?? 'admin'} ${fmtDateTime(d.createdAt)}] ${d.body}`).join('\n')}\n`
    : ''

  return `# Ticket #${i.ticket.fdTicketId}
subject: ${i.ticket.subject}
requester: ${i.ticket.requesterName ?? '—'} <${i.ticket.requesterEmail ?? '—'}>
opened: ${fmtDateTime(i.ticket.fdCreatedAt)}
${directives}
# Order data from our system
${orderBlock}

# Previous analyses of this ticket
${prev}

# Thread (oldest first)
${thread || '(no messages)'}`
}
