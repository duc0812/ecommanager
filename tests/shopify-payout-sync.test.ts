import { describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  fetchAllPayouts: vi.fn(),
  fetchBalance: vi.fn(),
  fetchBankAccounts: vi.fn(),
  getCredentialsFromRequest: vi.fn(() => ({ shop: 'store.myshopify.com', token: 'token' })),
  getShopifyConnection: vi.fn(async () => null),
  storeUpsert: vi.fn(async () => ({ id: 'store-1', shop: 'store.myshopify.com' })),
  storeUpdate: vi.fn(async () => ({})),
  bankUpsert: vi.fn(async () => ({})),
  payoutUpsert: vi.fn(async () => ({})),
}))

vi.mock('@/lib/shopify', () => ({
  fetchAllPayouts: mocks.fetchAllPayouts,
  fetchBalance: mocks.fetchBalance,
  fetchBankAccounts: mocks.fetchBankAccounts,
  getCredentialsFromRequest: mocks.getCredentialsFromRequest,
}))

vi.mock('@/lib/token-store', () => ({
  getShopifyConnection: mocks.getShopifyConnection,
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    shopifyStore: { upsert: mocks.storeUpsert, update: mocks.storeUpdate },
    bankAccount: { upsert: mocks.bankUpsert },
    payout: { upsert: mocks.payoutUpsert },
  },
}))

import { POST } from '@/app/api/shopify/sync/route'

describe('POST /api/shopify/sync', () => {
  it('fetches payouts and persists the complete current payout snapshot', async () => {
    mocks.fetchAllPayouts.mockResolvedValueOnce([{
      id: 101,
      status: 'paid',
      date: '2026-07-15',
      currency: 'USD',
      amount: '95.50',
      bank_account_id: null,
      summary: {
        charges_fee_amount: '4.50',
        charges_gross_amount: '100.00',
        refunds_fee_amount: '0.25',
        refunds_gross_amount: '-5.00',
        adjustments_fee_amount: '0.10',
        adjustments_gross_amount: '0.15',
      },
    }])
    mocks.fetchBalance.mockResolvedValueOnce({ amount: '12.34', currency: 'USD' })
    mocks.fetchBankAccounts.mockResolvedValueOnce([{
      id: 'gid://shopify/ShopifyPaymentsBankAccount/1',
      account_number: '****1234',
      bank_name: 'Test Bank',
      country: 'US',
      currency: 'USD',
      status: 'VALIDATED',
      verified: true,
    }])

    const request = new NextRequest('http://localhost/api/shopify/sync?date_min=2026-07-01&date_max=2026-07-31', {
      method: 'POST',
      headers: {
        'x-shopify-shop-domain': 'store.myshopify.com',
        'x-shopify-access-token': 'token',
      },
    })
    const response = await POST(request)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(mocks.fetchAllPayouts).toHaveBeenCalledWith(
      { shop: 'store.myshopify.com', token: 'token' },
      { date_min: '2026-07-01', date_max: '2026-07-31' },
    )
    expect(mocks.payoutUpsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 101 },
      update: expect.objectContaining({
        date: '2026-07-15',
        currency: 'USD',
        amount: 95.5,
        chargesFeeAmount: 4.5,
        chargesGrossAmount: 100,
        refundsFeeAmount: 0.25,
        refundsGrossAmount: -5,
        adjustmentsFeeAmount: 0.1,
        adjustmentsGrossAmount: 0.15,
        bankAccountShopifyId: 'gid://shopify/ShopifyPaymentsBankAccount/1',
      }),
    }))
    expect(body).toMatchObject({ success: true, synced_payouts: 1, synced_bank_accounts: 1 })
  })
})
