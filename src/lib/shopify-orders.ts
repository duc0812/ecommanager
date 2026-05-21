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
  productTags: string[]
  productType: string | null
  customAttributes: Array<{ key: string; value: string }>
  variantId: string | null          // NEW
  selectedOptions: Record<string, string>  // NEW: {"Style":"Tshirt","Size":"S"}
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
  shippingName: string | null
  shippingAddress1: string | null
  shippingAddress2: string | null
  shippingCity: string | null
  shippingZip: string | null
  shippingPhone: string | null
  lines: ShopifyOrderLine[]
  transactions: ShopifyTransaction[]
  refundedAmount: number
}

export type ShopifyShopInfo = {
  ianaTimezone: string | null
  timezoneAbbreviation: string | null
}

const QUERY = `
query SyncOrders($cursor: String, $query: String) {
  orders(first: 50, after: $cursor, query: $query, sortKey: CREATED_AT) {
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
      shippingAddress {
        name
        address1
        address2
        city
        zip
        phone
        country
        countryCodeV2
        province
      }
      taxLines { source priceSet { shopMoney { amount } } }
      lineItems(first: 50) {
        nodes {
          id sku title variantTitle quantity
          originalUnitPriceSet { shopMoney { amount } }
          customAttributes { key value }
          product { tags productType }
          variant {
            id
            selectedOptions { name value }
          }
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

const SHOP_QUERY = `
query ShopInfo {
  shop {
    ianaTimezone
    timezoneAbbreviation
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
      variables: { cursor, query: `created_at:>=${sinceIso}` },
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
      shippingName: n.shippingAddress?.name ?? null,
      shippingAddress1: n.shippingAddress?.address1 ?? null,
      shippingAddress2: n.shippingAddress?.address2 ?? null,
      shippingCity: n.shippingAddress?.city ?? null,
      shippingZip: n.shippingAddress?.zip ?? null,
      shippingPhone: n.shippingAddress?.phone ?? null,
      lines: (n.lineItems?.nodes || []).map((l: any) => ({
        id: l.id,
        sku: l.sku || null,
        title: l.title,
        variantTitle: l.variantTitle,
        quantity: l.quantity,
        unitPrice: num(l.originalUnitPriceSet),
        productTags: l.product?.tags ?? [],
        productType: l.product?.productType ?? null,
        customAttributes: l.customAttributes ?? [],
        variantId: l.variant?.id ?? null,
        selectedOptions: Object.fromEntries(
          (l.variant?.selectedOptions ?? []).map((o: { name: string; value: string }) => [o.name, o.value])
        ),
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

export async function fetchShopInfo(
  shop: string,
  accessToken: string,
  apiVersion = '2024-10',
): Promise<ShopifyShopInfo> {
  const url = `https://${shop}/admin/api/${apiVersion}/graphql.json`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': accessToken,
    },
    body: JSON.stringify({ query: SHOP_QUERY }),
  })
  if (!res.ok) throw new Error(`Shopify GraphQL ${res.status}: ${await res.text()}`)
  const json = await res.json()
  if (json.errors) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`)
  return {
    ianaTimezone: json.data?.shop?.ianaTimezone ?? null,
    timezoneAbbreviation: json.data?.shop?.timezoneAbbreviation ?? null,
  }
}
