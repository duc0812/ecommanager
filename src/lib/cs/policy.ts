import type { CsSettings } from '@/lib/cs/settings'
import type { OrderMatch } from '@/lib/cs/order-context'
import type { CsCategory, CsSentiment } from '@/lib/cs/triage'

export type GateInput = {
  settings: Pick<CsSettings, 'autoReplyEnabled' | 'autoReplyCategories' | 'autoReplyDailyCap' | 'killSwitch' | 'productionDays' | 'shippingDays'>
  category: CsCategory
  sentiment: CsSentiment
  orderMatch: OrderMatch
  customerMessageCount: number
  hasAnyReply: boolean
  hasTracking: boolean
  placedAt: Date | null
  now: Date
  textMentionsRefundAddressOrCancel: boolean
  autoRepliesToday: number
  hasActiveCaseForCategory: boolean
}

export const BASELINE_CATEGORIES: CsCategory[] = ['ORDER_STATUS']

const RISKY = /refund|charge ?back|dispute|cancel|wrong address|change (the |my )?address|different address|send(ing)? it to/i

export function mentionsRefundAddressOrCancel(text: string): boolean {
  return RISKY.test(text)
}

export function autoReplyGate(i: GateInput): { allowed: boolean; reasons: string[] } {
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
  return { allowed: reasons.length === 0, reasons }
}
