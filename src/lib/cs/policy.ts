import type { CsSettings } from '@/lib/cs/settings'
import type { OrderMatch } from '@/lib/cs/order-context'
import type { CsCategory, CsSentiment } from '@/lib/cs/triage'
import type { CsMode } from '@/lib/cs/hours'

export type GateInput = {
  settings: Pick<CsSettings, 'autoReplyEnabled' | 'autoReplyCategories' | 'autoReplyDailyCap' | 'killSwitch' | 'productionDays' | 'shippingDays' | 'afterHoursAutoReply' | 'afterHoursCategories'>
  mode: CsMode
  category: CsCategory
  sentiment: CsSentiment
  orderMatch: OrderMatch
  customerMessageCount: number
  hasAnyReply: boolean
  pendingCustomerMessage: boolean
  hasTracking: boolean
  placedAt: Date | null
  now: Date
  textMentionsRefundAddressOrCancel: boolean
  autoRepliesToday: number
  autoRepliesOnTicket24h: number
  openDirectives: number
  hasActiveCaseForCategory: boolean
}

export type GateResult = { allowed: boolean; reasons: string[]; mode: CsMode }

export const BASELINE_CATEGORIES: CsCategory[] = ['ORDER_STATUS']
export const AFTER_HOURS_TICKET_CAP = 2

const RISKY = /refund|charge ?back|dispute|cancel|wrong address|change (the |my )?address|different address|send(ing)? it to/i

export function mentionsRefundAddressOrCancel(text: string): boolean {
  return RISKY.test(text)
}

function businessGate(i: GateInput): string[] {
  const reasons: string[] = []
  const s = i.settings
  if (!s.autoReplyEnabled) reasons.push('auto-reply disabled')
  if (s.killSwitch) reasons.push('kill switch on')
  if (!s.autoReplyCategories.includes(i.category)) reasons.push(`category ${i.category} not allowed`)
  if (i.customerMessageCount !== 1) reasons.push('not the customer\'s first message')
  if (i.hasAnyReply) reasons.push('ticket already replied')
  if (i.orderMatch !== 'EXACT' && i.orderMatch !== 'BY_EMAIL') reasons.push(`order match ${i.orderMatch}`)
  if (i.sentiment === 'ANGRY' || i.sentiment === 'DISPUTE_THREAT') reasons.push(`sentiment ${i.sentiment}`)
  if (i.textMentionsRefundAddressOrCancel) reasons.push('text mentions refund/address/cancel')
  if (!i.hasTracking) {
    const windowMs = (s.productionDays + s.shippingDays) * 86400_000
    const inWindow = i.placedAt !== null && i.now.getTime() - i.placedAt.getTime() <= windowMs
    if (!inWindow) reasons.push('no tracking and order outside the promised window')
  }
  if (i.autoRepliesToday >= s.autoReplyDailyCap) reasons.push('daily cap reached')
  if (!BASELINE_CATEGORIES.includes(i.category) && !i.hasActiveCaseForCategory) reasons.push('no active case for this category')
  return reasons
}

function afterHoursGate(i: GateInput): string[] {
  const reasons: string[] = []
  const s = i.settings
  if (!s.afterHoursAutoReply) reasons.push('after-hours auto-reply disabled')
  if (s.killSwitch) reasons.push('kill switch on')
  if (!s.afterHoursCategories.includes(i.category)) reasons.push(`category ${i.category} not allowed after hours`)
  if (!i.pendingCustomerMessage) reasons.push('no customer message waiting')
  if (i.orderMatch !== 'EXACT' && i.orderMatch !== 'BY_EMAIL' && i.category !== 'PRODUCT_QUESTION') reasons.push(`order match ${i.orderMatch}`)
  if (i.sentiment === 'DISPUTE_THREAT') reasons.push(`sentiment ${i.sentiment}`)
  if (i.openDirectives > 0) reasons.push('open admin directive — staff carries it out')
  if (i.autoRepliesOnTicket24h >= AFTER_HOURS_TICKET_CAP) reasons.push('ticket already auto-replied twice in 24h')
  if (i.autoRepliesToday >= s.autoReplyDailyCap) reasons.push('daily cap reached')
  return reasons
}

export function autoReplyGate(i: GateInput): GateResult {
  const reasons = i.mode === 'AFTER_HOURS' ? afterHoursGate(i) : businessGate(i)
  return { allowed: reasons.length === 0, reasons, mode: i.mode }
}
