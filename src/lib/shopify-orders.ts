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

// ─── Fulfillment tracking (for Tracking Management) ─────────────────────────
// Lightweight query kept separate from the heavy order sync so it does not bloat
// every order-sync page. Only pulls what the tracking page needs.

export type ShopifyFulfillment = {
  id: string
  displayStatus: string | null      // Shopify's own status (SUCCESS/IN_TRANSIT/DELIVERED/…)
  deliveredAt: string | null
  trackingNumber: string | null
  carrier: string | null            // tracking company, e.g. "YunExpress"
  trackingUrl: string | null
  lineItemIds: string[]             // Shopify LineItem GIDs covered by this fulfillment (== OrderLine.shopifyLineId)
}

export type ShopifyOrderFulfillments = {
  id: string       // order GID
  name: string     // "#1023"
  fulfillmentStatus: string | null   // order-level displayFulfillmentStatus (FULFILLED/UNFULFILLED/PARTIALLY_FULFILLED/…)
  fulfillments: ShopifyFulfillment[]
}

export type ShopifyFulfillmentsPage = {
  orders: ShopifyOrderFulfillments[]
  hasNextPage: boolean
  endCursor: string | null
}

const FULFILLMENTS_QUERY = `
query SyncFulfillments($cursor: String, $query: String) {
  orders(first: 50, after: $cursor, query: $query, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id name
      displayFulfillmentStatus
      fulfillments(first: 20) {
        id
        displayStatus
        deliveredAt
        trackingInfo(first: 10) { number company url }
        fulfillmentLineItems(first: 100) {
          nodes { lineItem { id } }
        }
      }
    }
  }
}`

// Write a SKU onto a product variant (SKU lives on the variant's inventory item).
// Requires the write_products scope. Returns void on success, throws on error.
export async function updateVariantSku(
  shop: string,
  accessToken: string,
  variantId: string,
  sku: string,
  apiVersion = '2024-10',
): Promise<void> {
  const url = `https://${shop}/admin/api/${apiVersion}/graphql.json`
  const gql = async (query: string, variables: any) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
      body: JSON.stringify({ query, variables }),
    })
    if (!res.ok) throw new Error(`Shopify ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const json = await res.json()
    if (json.errors) throw new Error(json.errors.map((e: any) => e.message).join('; '))
    return json.data
  }
  const pv = await gql(`query($id: ID!) { productVariant(id: $id) { product { id } } }`, { id: variantId })
  const productId = pv?.productVariant?.product?.id
  if (!productId) throw new Error('Không tìm thấy variant/product trên Shopify')
  const data = await gql(
    `mutation($pid: ID!, $vid: ID!, $sku: String!) {
      productVariantsBulkUpdate(productId: $pid, variants: [{ id: $vid, inventoryItem: { sku: $sku } }]) {
        userErrors { field message }
      }
    }`,
    { pid: productId, vid: variantId, sku },
  )
  const errs = data?.productVariantsBulkUpdate?.userErrors ?? []
  if (errs.length > 0) throw new Error(errs.map((e: any) => e.message).join('; '))
}

// Fetch the CURRENT sku of product variants (by GID). Order line items snapshot
// the sku at order-creation time, so a sku added later only shows on the variant —
// this reads it from the variant so a missing-sku order can be backfilled.
export async function fetchVariantSkus(
  shop: string,
  accessToken: string,
  variantIds: string[],
  apiVersion = '2024-10',
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>()
  const ids = Array.from(new Set(variantIds.filter(Boolean)))
  if (ids.length === 0) return out
  const url = `https://${shop}/admin/api/${apiVersion}/graphql.json`
  for (let i = 0; i < ids.length; i += 250) {
    const batch = ids.slice(i, i + 250)
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
      body: JSON.stringify({
        query: `query VariantSkus($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant { id sku } } }`,
        variables: { ids: batch },
      }),
    })
    if (!res.ok) throw new Error(`Shopify GraphQL ${res.status}: ${await res.text()}`)
    const json = await res.json()
    if (json.errors) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`)
    for (const n of json.data?.nodes || []) {
      if (n && n.id) out.set(n.id, n.sku && n.sku.trim() ? n.sku.trim() : null)
    }
  }
  return out
}

export async function fetchOrderFulfillmentsPage(
  shop: string,
  accessToken: string,
  cursor: string | null,
  sinceIso: string,
  apiVersion = '2024-10',
): Promise<ShopifyFulfillmentsPage> {
  const url = `https://${shop}/admin/api/${apiVersion}/graphql.json`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': accessToken,
    },
    body: JSON.stringify({
      query: FULFILLMENTS_QUERY,
      variables: { cursor, query: `created_at:>=${sinceIso}` },
    }),
  })
  if (!res.ok) throw new Error(`Shopify GraphQL ${res.status}: ${await res.text()}`)
  const json = await res.json()
  if (json.errors) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`)

  const conn = json.data.orders
  const orders: ShopifyOrderFulfillments[] = conn.nodes.map((n: any) => ({
    id: n.id,
    name: n.name,
    fulfillmentStatus: n.displayFulfillmentStatus ?? null,
    fulfillments: (n.fulfillments || []).map((f: any) => {
      const track = (f.trackingInfo || [])[0] ?? null
      return {
        id: f.id,
        displayStatus: f.displayStatus ?? null,
        deliveredAt: f.deliveredAt ?? null,
        trackingNumber: track?.number ?? null,
        carrier: track?.company ?? null,
        trackingUrl: track?.url ?? null,
        lineItemIds: (f.fulfillmentLineItems?.nodes || [])
          .map((li: any) => li.lineItem?.id)
          .filter(Boolean) as string[],
      }
    }),
  }))
  return {
    orders,
    hasNextPage: conn.pageInfo.hasNextPage,
    endCursor: conn.pageInfo.endCursor,
  }
}

// ─── Fulfillment tracking WRITE-back (push last-mile number to Shopify) ──────

export type OrderFulfillmentRef = {
  orderId: string
  orderName: string
  fulfillments: Array<{ id: string; status: string; trackingNumbers: string[] }>
}

export async function fetchOrderFulfillmentsByName(
  shop: string,
  accessToken: string,
  orderName: string,     // e.g. "#LIT2929"
  apiVersion = '2024-10',
): Promise<OrderFulfillmentRef[]> {
  const url = `https://${shop}/admin/api/${apiVersion}/graphql.json`
  const query = `
    query($q: String!) {
      orders(first: 5, query: $q) {
        nodes {
          id name
          fulfillments(first: 20) { id status trackingInfo { number } }
        }
      }
    }`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
    body: JSON.stringify({ query, variables: { q: `name:${orderName}` } }),
  })
  if (!res.ok) throw new Error(`Shopify GraphQL ${res.status}: ${await res.text()}`)
  const json = await res.json()
  if (json.errors) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`)
  return (json.data?.orders?.nodes ?? []).map((o: any) => ({
    orderId: o.id,
    orderName: o.name,
    fulfillments: (o.fulfillments ?? []).map((f: any) => ({
      id: f.id,
      status: f.status,
      trackingNumbers: (f.trackingInfo ?? []).map((t: any) => t.number).filter(Boolean),
    })),
  }))
}

export type TrackingUpdateResult = { ok: boolean; error?: string; trackingInfo?: Array<{ company: string | null; number: string | null; url: string | null }> }

export async function updateFulfillmentTracking(
  shop: string,
  accessToken: string,
  fulfillmentId: string,
  input: { company?: string; number: string; url?: string },
  notifyCustomer = false,
  apiVersion = '2024-10',
): Promise<TrackingUpdateResult> {
  const url = `https://${shop}/admin/api/${apiVersion}/graphql.json`
  const mutation = `
    mutation($fulfillmentId: ID!, $trackingInfoInput: FulfillmentTrackingInput!, $notifyCustomer: Boolean) {
      fulfillmentTrackingInfoUpdate(fulfillmentId: $fulfillmentId, trackingInfoInput: $trackingInfoInput, notifyCustomer: $notifyCustomer) {
        fulfillment { id trackingInfo { company number url } }
        userErrors { field message }
      }
    }`
  const trackingInfoInput: Record<string, string> = { number: input.number }
  if (input.company) trackingInfoInput.company = input.company
  if (input.url) trackingInfoInput.url = input.url

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
    body: JSON.stringify({ query: mutation, variables: { fulfillmentId, trackingInfoInput, notifyCustomer } }),
  })
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` }
  const json = await res.json()
  if (json.errors) return { ok: false, error: `GraphQL: ${JSON.stringify(json.errors).slice(0, 300)}` }
  const payload = json.data?.fulfillmentTrackingInfoUpdate
  const userErrors = payload?.userErrors ?? []
  if (userErrors.length > 0) return { ok: false, error: userErrors.map((e: any) => e.message).join('; ') }
  return { ok: true, trackingInfo: payload?.fulfillment?.trackingInfo ?? [] }
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
