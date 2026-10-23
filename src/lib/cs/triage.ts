import type { FactoryState } from '@/lib/cs/order-context'

export const CS_CATEGORIES = [
  'ADDRESS_CHANGE', 'CANCEL_ORDER', 'ORDER_STATUS', 'DAMAGED_OR_DEFECTIVE', 'WRONG_ITEM', 'MISSING_ITEM',
  'DELIVERED_NOT_RECEIVED', 'REFUND_REQUEST', 'PRODUCT_QUESTION', 'PERSONALIZATION_ISSUE', 'OTHER', 'SPAM',
] as const
export const CS_URGENCIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const
export const CS_SENTIMENTS = ['CALM', 'FRUSTRATED', 'ANGRY', 'DISPUTE_THREAT'] as const

export type CsCategory = typeof CS_CATEGORIES[number]
export type CsUrgency = typeof CS_URGENCIES[number]
export type CsSentiment = typeof CS_SENTIMENTS[number]

const RANK: Record<CsUrgency, number> = { LOW: 0, NORMAL: 1, HIGH: 2, URGENT: 3 }
const TIME_RACE: CsCategory[] = ['ADDRESS_CHANGE', 'CANCEL_ORDER']
const HIGH_RISK: CsCategory[] = ['DAMAGED_OR_DEFECTIVE', 'WRONG_ITEM', 'MISSING_ITEM', 'DELIVERED_NOT_RECEIVED', 'REFUND_REQUEST']

function bump(u: CsUrgency): CsUrgency {
  return CS_URGENCIES[Math.min(RANK[u] + 1, CS_URGENCIES.length - 1)]
}

export function ruleUrgency(i: { category: CsCategory; factoryState: FactoryState | null; sentiment: CsSentiment; hoursUnanswered: number }): CsUrgency {
  let u: CsUrgency
  if (i.category === 'SPAM') return 'LOW'
  if (TIME_RACE.includes(i.category)) u = i.factoryState === null || i.factoryState === 'NOT_SENT' ? 'URGENT' : 'HIGH'
  else if (HIGH_RISK.includes(i.category)) u = 'HIGH'
  else u = 'NORMAL'
  if (i.sentiment === 'DISPUTE_THREAT' && RANK[u] < RANK.HIGH) u = 'HIGH'
  if (i.hoursUnanswered > 24) u = bump(u)
  return u
}

export function finalUrgency(modelUrgency: CsUrgency, rule: CsUrgency): CsUrgency {
  return RANK[modelUrgency] >= RANK[rule] ? modelUrgency : rule
}

export function urgencyToPriority(u: CsUrgency): 1 | 2 | 3 | 4 {
  return ({ LOW: 1, NORMAL: 2, HIGH: 3, URGENT: 4 } as const)[u]
}

export function categoryTag(category: CsCategory): string {
  return `em-${category.toLowerCase().replace(/_/g, '-')}`
}

export function tagsFor(category: CsCategory, urgency: CsUrgency, existing: string[]): string[] {
  const kept = existing.filter(t => !t.startsWith('em-') || t === 'em-auto-replied')
  const out = [...kept, categoryTag(category)]
  if (urgency === 'URGENT') out.push('em-urgent')
  if (urgency === 'HIGH') out.push('em-high')
  return out
}
