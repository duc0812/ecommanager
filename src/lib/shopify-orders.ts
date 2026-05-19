export type ShopifyOrdersPage = {
  orders: ShopifyOrder[]
  hasNextPage: boolean
  endCursor: string | null
}

export type ShopifyTransaction = {
  id: string
  kind: string
  status: string
  amount: number
  fees: number
  processedAt: string
}

export type ShopifyOrderLine = {
  id: string
  sku: string | null
  title: string
  variantTitle: string | null
  quantity: number
  unitPrice: number
}

export type ShopifyOrder = {
  id: string
  name: string
  createdAt: string
  processedAt: string | null
  financialStatus: string
  fulfillmentStatus: string | null
  currency: string
  grossAmount: number
  subtotal: number
  shipping: number
  tax: number
  taxMarketplaceCollected: number
  customerEmail: string | null
  customerName: string | null
  shippingCountry: string | null
  shippingState: string | null
  lines: ShopifyOrderLine[]
  transactions: ShopifyTransaction[]
  refundedAmount: number
}

const QUERY = `
query SyncOrders($cursor: String, $query: String) {
  orders(first: 50, after: $cursor, query: $query, sortKey: PROCESSED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id name createdAt processedAt
      displayFinancialStatus displayFulfillmentStatus
      currencyCode
      currentTotalPriceSet { shopMoney { amount } }
      currentSubtotalPriceSet { shopMoney { amount } }
      currentTotalTaxSet { shopMoney { amount } }
      currentShippingPriceSet { shopMoney { amount } }
      customer { email displayName }
      shippingAddress { country countryCodeV2 province }
      taxLines { source priceSet { shopMoney { amount } } }
      lineItems(first: 50) {
        nodes {
          id sku title variantTitle quantity
          originalUnitPriceSet { shopMoney { amount } }
        }
      }
      transactions(first: 20) {
        id kind status processedAt
        amountSet { shopMoney { amount } }
        fees { amount { amount } }
      }
      refunds(first: 10) {
        totalRefundedSet { shopMoney { amount } }
      }
    }
  }
}`

function num(v: { shopMoney: { amount: string } } | null | undefined): number {
  if (!v) return 0
  return parseFloat(v.shopMoney.amount) || 0
}

export async function fetchOrdersPage(
  shop: string,
  accessToken: string,
  cursor: string | null,
  sinceIso: string,
  apiVersion = '2024-10',
): Promise<ShopifyOrdersPage> {
  const url = `https://${shop}/admin/api/${apiVersion}/graphql.json`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': accessToken,
    },
    body: JSON.stringify({
      query: QUERY,
      variables: { cursor, query: `processed_at:>=${sinceIso}` },
    }),
  })
  if (!res.ok) throw new Error(`Shopify GraphQL ${res.status}: ${await res.text()}`)
  const json = await res.json()
  if (json.errors) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`)

  const conn = json.data.orders
  const orders: ShopifyOrder[] = conn.nodes.map((n: any) => {
    const transactions: ShopifyTransaction[] = (n.transactions || []).map((tx: any) => ({
      id: tx.id,
      kind: tx.kind,
      status: tx.status,
      amount: num(tx.amountSet),
      fees: (tx.fees || []).reduce((sum: number, f: any) => sum + parseFloat(f.amount?.amount || '0'), 0),
      processedAt: tx.processedAt,
    }))
    const refundedAmount = (n.refunds || []).reduce(
      (sum: number, r: any) => sum + num(r.totalRefundedSet), 0
    )
    const taxMarketplaceCollected = (n.taxLines || [])
      .filter((t: any) => t.source === 'marketplace')
      .reduce((sum: number, t: any) => sum + num(t.priceSet), 0)
    return {
      id: n.id,
      name: n.name,
      createdAt: n.createdAt,
      processedAt: n.processedAt,
      financialStatus: n.displayFinancialStatus,
      fulfillmentStatus: n.displayFulfillmentStatus,
      currency: n.currencyCode,
      grossAmount: num(n.currentTotalPriceSet),
      subtotal: num(n.currentSubtotalPriceSet),
      shipping: num(n.currentShippingPriceSet),
      tax: num(n.currentTotalTaxSet),
      taxMarketplaceCollected,
      customerEmail: n.customer?.email ?? null,
      customerName: n.customer?.displayName ?? null,
      shippingCountry: n.shippingAddress?.countryCodeV2 ?? n.shippingAddress?.country ?? null,
      shippingState: n.shippingAddress?.province ?? null,
      lines: (n.lineItems?.nodes || []).map((l: any) => ({
        id: l.id,
        sku: l.sku || null,
        title: l.title,
        variantTitle: l.variantTitle,
        quantity: l.quantity,
        unitPrice: num(l.originalUnitPriceSet),
      })),
      transactions,
      refundedAmount,
    }
  })
  return {
    orders,
    hasNextPage: conn.pageInfo.hasNextPage,
    endCursor: conn.pageInfo.endCursor,
  }
}
