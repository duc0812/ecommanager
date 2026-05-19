'use client'
import Link from 'next/link'
import Sidebar from '@/components/Sidebar'

const modules = [
  {
    href: '/fulfillment/crawler',
    icon: 'travel_explore',
    title: 'Product Crawler',
    desc: 'Crawl public Shopify products, create design SKUs, and check supplier mapping before publishing.',
  },
  {
    href: '/fulfillment/orders',
    icon: 'receipt_long',
    title: 'Orders & P/L',
    desc: 'Sync Shopify orders, auto-map supplier SKU, track pipeline status, and review per-order profit.',
  },
  {
    href: '/fulfillment/export',
    icon: 'file_download',
    title: 'CSV Export',
    desc: 'Generate supplier-ready fulfillment files with Design SKU and Supplier SKU.',
  },
  {
    href: '/fulfillment/suppliers',
    icon: 'factory',
    title: 'Suppliers',
    desc: 'Manage supplier profiles, shipping defaults, and export templates.',
  },
  {
    href: '/fulfillment/products',
    icon: 'inventory_2',
    title: 'Product Mapping',
    desc: 'Import supplier SKU sheets and maintain base cost, size, product type, and shipping rules.',
  },
  {
    href: '/fulfillment/costs',
    icon: 'payments',
    title: 'Cost Register',
    desc: 'Record landed fulfillment costs, invoices, product cost, shipping, storage, and adjustments.',
  },
]

export default function FulfillmentDashboardPage() {
  return (
    <div className="flex min-h-screen bg-surface">
      <Sidebar />
      <main className="ml-[280px] flex-1 p-xl">
        <header className="mb-xl">
          <p className="text-label-sm text-on-surface-variant uppercase tracking-wider mb-xs">Operations</p>
          <h1 className="text-display-md text-primary">Fulfillment</h1>
          <p className="text-body-md text-on-surface-variant mt-xs max-w-3xl">
            Manage the order lifecycle from Shopify sync to supplier-ready export and cost tracking.
          </p>
        </header>

        <section className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-lg">
          {modules.map(m => (
            <Link
              key={m.href}
              href={m.href}
              className="bg-surface-container-lowest rounded-xl border border-outline-variant/20 p-lg hover:border-secondary/50 hover:shadow-card transition-all"
            >
              <div className="flex items-center gap-md mb-md">
                <span className="material-symbols-outlined text-secondary text-[24px]">{m.icon}</span>
                <h2 className="text-headline-sm text-primary">{m.title}</h2>
              </div>
              <p className="text-body-sm text-on-surface-variant">{m.desc}</p>
            </Link>
          ))}
        </section>
      </main>
    </div>
  )
}
