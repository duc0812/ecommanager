import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  fetchAllPayouts: vi.fn(),
  fetchBalance: vi.fn(),
  fetchBankAccounts: vi.fn(),
}))

vi.mock('@/lib/shopify', () => ({
  fetchAllPayouts: mocks.fetchAllPayouts,
  fetchBalance: mocks.fetchBalance,
  fetchBankAccounts: mocks.fetchBankAccounts,
}))

import { prisma } from '@/lib/db'
import { saveStoreCredential } from '@/lib/store-connections'
import { POST } from '@/app/api/shopify/sync/route'

const SHOP = 'sps-store.myshopify.com'
const PAYOUT_ID = 9_100_101
const BANK_ID = 'gid://shopify/ShopifyPaymentsBankAccount/sps-1'
let storeId = ''

beforeAll(async () => {
  await prisma.shopifyStore.deleteMany({ where: { shop: SHOP } })
  storeId = (await prisma.shopifyStore.create({ data: { shop: SHOP } })).id
  await saveStoreCredential(storeId, { authMode: 'TOKEN', accessToken: 'token' })
})

afterAll(async () => {
  await prisma.payout.deleteMany({ where: { storeId } })
  await prisma.bankAccount.deleteMany({ where: { storeId } })
  await prisma.shopifyStore.deleteMany({ where: { id: storeId } })
})

describe('POST /api/shopify/sync', () => {
  it('fetches payouts and persists the complete current payout snapshot', async () => {
    mocks.fetchAllPayouts.mockResolvedValueOnce([{
      id: PAYOUT_ID,
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
      id: BANK_ID,
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
        'x-shopify-shop-domain': SHOP,
        'x-shopify-access-token': 'ignored',
      },
    })
    const response = await POST(request)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(mocks.fetchAllPayouts).toHaveBeenCalledWith(
      { shop: SHOP, token: 'token' },
      { date_min: '2026-07-01', date_max: '2026-07-31' },
    )
    const saved = await prisma.payout.findUnique({ where: { id: PAYOUT_ID } })
    expect(saved).toMatchObject({
      storeId,
      date: '2026-07-15',
      currency: 'USD',
      amount: 95.5,
      chargesFeeAmount: 4.5,
      chargesGrossAmount: 100,
      refundsFeeAmount: 0.25,
      refundsGrossAmount: -5,
      adjustmentsFeeAmount: 0.1,
      adjustmentsGrossAmount: 0.15,
      bankAccountShopifyId: BANK_ID,
    })
    expect(await prisma.bankAccount.findUnique({ where: { id: BANK_ID } })).toMatchObject({ storeId, bankName: 'Test Bank' })
    expect(await prisma.shopifyStore.findUnique({ where: { id: storeId } })).toMatchObject({ currentBalance: 12.34, currentBalanceCurrency: 'USD' })
    expect(body).toMatchObject({ success: true, synced_payouts: 1, synced_bank_accounts: 1 })
    expect(body.stores).toEqual([{ storeId, shop: SHOP, ok: true }])
  })
})
