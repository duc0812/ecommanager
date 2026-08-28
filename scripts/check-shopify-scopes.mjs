import { createClient } from '@libsql/client'
import path from 'path'

// Scopes the app CURRENTLY requests (must match src/app/api/auth/shopify/route.ts)
const REQUESTED = [
  'read_analytics', 'read_orders', 'read_customers', 'read_customer_payment_methods',
  'read_products', 'read_product_listings', 'write_product_listings',
  'read_product_feeds', 'write_product_feeds',
  'read_fulfillments', 'write_fulfillments',
  'read_assigned_fulfillment_orders', 'write_assigned_fulfillment_orders',
  'read_merchant_managed_fulfillment_orders', 'write_merchant_managed_fulfillment_orders',
  'read_custom_fulfillment_services', 'write_custom_fulfillment_services',
  'read_discounts', 'write_discounts', 'read_price_rules', 'write_price_rules',
  'read_content', 'write_content', 'read_themes', 'write_themes', 'write_theme_code',
  'read_shopify_payments_payouts', 'read_shopify_payments_bank_accounts',
  'read_shopify_payments_disputes', 'read_shopify_payments_accounts',
  'customer_read_orders', 'customer_write_orders',
]

const dbUrl = 'file:' + path.resolve(process.cwd(), 'dev.db')
const db = createClient({ url: dbUrl })

const keys = ['shopify.connection.shop', 'shopify.connection.token', 'shopify.connection.connectedAt']
const rs = await db.execute({
  sql: `SELECT key, value FROM AppSetting WHERE key IN (?, ?, ?)`,
  args: keys,
})
const settings = Object.fromEntries(rs.rows.map(r => [r.key, r.value]))
const shop = settings['shopify.connection.shop']
const token = settings['shopify.connection.token']

if (!shop || !token) {
  console.log('❌ Chưa có store nào được kết nối trong DB (prisma/dev.db).')
  process.exit(0)
}

console.log('Store:', shop)
console.log('Connected at:', settings['shopify.connection.connectedAt'])
console.log('Token prefix:', String(token).slice(0, 12) + '…')
console.log('')

const res = await fetch(`https://${shop}/admin/oauth/access_scopes.json`, {
  headers: { 'X-Shopify-Access-Token': token },
})
if (!res.ok) {
  console.log('❌ API error', res.status, await res.text())
  process.exit(1)
}
const data = await res.json()
const granted = (data.access_scopes ?? []).map(s => s.handle)

console.log('=== SCOPES ĐÃ ĐƯỢC CẤP (thực tế trên store) ===')
console.log(granted.join(', ') || '(none)')
console.log('')

const missing = REQUESTED.filter(s => !granted.includes(s))
const extra = granted.filter(s => !REQUESTED.includes(s))

if (missing.length === 0) {
  console.log('✅ ĐỦ QUYỀN — store đã cập nhật, có tất cả scopes app yêu cầu.')
} else {
  console.log('⚠️  THIẾU QUYỀN — store CHƯA re-authorize. Các scope còn thiếu:')
  console.log('   ' + missing.join(', '))
  console.log('')
  console.log('   → Cần vào /setup và bấm kết nối lại (OAuth) để cấp quyền mới.')
}
if (extra.length) console.log('ℹ️  Scope thừa (store có nhưng app không còn yêu cầu):', extra.join(', '))
