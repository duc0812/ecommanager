import { describe, it, expect } from 'vitest'
import { buildReviewSystemPrompt, buildReviewUserPrompt, guardDraft } from '@/lib/cs/review-recovery-prompt'

describe('buildReviewSystemPrompt', () => {
  it('carries the rules', () => {
    const s = buildReviewSystemPrompt().toLowerCase()
    for (const needle of ['we saw the review', 'never mention the star', 'never ask', 'not yet shipped', 'delivered', 'shipping protection', 'one specific question', 'warm regards', 'litzzy support', 'not_received', 'not_as_pictured', 'wrong_item', 'personalization', 'quality'])
      expect(s, needle).toContain(needle)
  })
})

describe('buildReviewUserPrompt', () => {
  it('shows the review and the order state', () => {
    const p = buildReviewUserPrompt({
      review: { body: 'Still waiting for my shirt', title: 'Sad', productTitle: 'Shipping protection', reviewerName: 'Maricela', reviewCreatedAt: new Date('2026-11-08T10:00:00Z') },
      order: { id: 'o', shopifyOrderNumber: '#LIT1', placedAt: new Date('2026-10-01T00:00:00Z'), customerName: 'Maricela Ruiz', customerEmail: 'm@x.com', shipTo: 'Austin TX', factoryState: 'SHIPPED', supplierHandoffAt: null, pipelineStatus: 'FULFILLED',
        lines: [{ title: 'Stwa Galaxy Shirt', variant: 'L', qty: 1, customized: true, personalization: 'Custom Name: Mari' }],
        shipments: [{ trackingNumber: 'YT1', carrier: 'YunExpress', status: 'IN_TRANSIT', lastCheckpointAt: new Date('2026-10-20T00:00:00Z'), trackingUrl: 'https://litzzy.com/apps/trackingorder?nums=YT1' }], designTaskStatuses: [], items: [] },
      reviewedLine: 'Stwa Galaxy Shirt',
      refunded: 0,
    })
    for (const needle of ['Still waiting for my shirt', '#LIT1', 'SHIPPED', 'YT1', 'IN_TRANSIT', 'Stwa Galaxy Shirt', 'Maricela'])
      expect(p, needle).toContain(needle)
  })
})

describe('guardDraft', () => {
  const clean = "Hi Ann,\n\nWe saw the review you left for the Stwa shirt on order #LIT1. I checked your parcel and it has not moved since Oct 20. Could you tell us whether anything was left with a neighbour?\n\nWarm regards,\nLitzzy Support"
  it('passes a clean draft', () => expect(guardDraft(clean)).toBeNull())
  it('rejects a draft that asks to update the review', () => expect(guardDraft(clean + '\nWould you consider updating your review?')).not.toBeNull())
  it('rejects a draft that mentions stars', () => expect(guardDraft(clean.replace('the Stwa shirt', 'the Stwa shirt (1 star)'))).not.toBeNull())
  it('rejects an offer', () => expect(guardDraft(clean + '\nWe can send a replacement.')).not.toBeNull())
  it('rejects a draft that never mentions the review', () => expect(guardDraft(clean.replace('We saw the review you left for', 'About'))).not.toBeNull())
})

describe('guardDraft on the subject and stars', () => {
  const clean = "Hi Ann,\n\nWe saw the review you left for the Stwa shirt on order #LIT1. Could you tell us what happened?\n\nWarm regards,\nLitzzy Support"
  it('rejects the star character', () => expect(guardDraft(clean.replace('Stwa shirt', 'Stwa shirt ★'))).not.toBeNull())
  it('rejects a subject that names the score', () => expect(guardDraft(clean, 'About your 1-star review')).not.toBeNull())
  it('rejects an empty subject', () => expect(guardDraft(clean, ' ')).not.toBeNull())
  it('passes a clean subject', () => expect(guardDraft(clean, 'About your Stwa shirt, order #LIT1')).toBeNull())
})
