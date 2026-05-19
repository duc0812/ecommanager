'use client'
import { FormEvent, useState } from 'react'
import Sidebar from '@/components/Sidebar'

type Mapping = {
  variantId: number
  optionValues: string[]
  variantTitle: string
  designSku: string
  supplierSku: string | null
  supplierName: string | null
  baseCost: number | null
  score: number
  reasons: string[]
}

type CrawlResult = {
  product: {
    title: string
    handle: string
    vendor: string
    productType: string
    tags: string[] | string
    image: string | null
    variantCount: number
    imageCount: number
  }
  mappings: Mapping[]
  unmappedCount: number
  csv: string
}

export default function FulfillmentCrawlerPage() {
  const [url, setUrl] = useState('')
  const [skuPrefix, setSkuPrefix] = useState('')
  const [status, setStatus] = useState<'draft' | 'active' | 'archived'>('draft')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<CrawlResult | null>(null)

  async function crawl(e: FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    setResult(null)
    const res = await fetch('/api/fulfillment/crawler', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, skuPrefix, status }),
    })
    const data = await res.json()
    if (!res.ok) {
      setError(data.error || 'Crawler failed')
      setLoading(false)
      return
    }
    setResult(data)
    setLoading(false)
  }

  function downloadCsv() {
    if (!result) return
    const blob = new Blob([result.csv], { type: 'text/csv;charset=utf-8' })
    const objectUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = objectUrl
    a.download = `${result.product.handle || 'product'}.shopify.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(objectUrl)
  }

  const tags = Array.isArray(result?.product.tags)
    ? result?.product.tags.join(', ')
    : result?.product.tags ?? ''

  return (
    <div className="flex min-h-screen bg-surface">
      <Sidebar />
      <main className="ml-[280px] flex-1 p-xl">
        <header className="mb-xl">
          <p className="text-label-sm text-on-surface-variant uppercase tracking-wider mb-xs">Fulfillment</p>
          <h1 className="text-display-md text-primary">Product Crawler</h1>
          <p className="text-body-md text-on-surface-variant mt-xs max-w-3xl">
            Crawl public Shopify products, generate your internal design SKUs, and verify supplier mapping before publishing.
          </p>
        </header>

        <form onSubmit={crawl} className="bg-surface-container-lowest rounded-xl border border-outline-variant/20 p-lg mb-lg">
          <div className="grid grid-cols-1 xl:grid-cols-[1fr_240px_160px_auto] gap-md items-end">
            <label className="block">
              <span className="text-label-sm block mb-xs">Product URL</span>
              <input
                value={url}
                onChange={e => setUrl(e.target.value)}
                placeholder="https://store.com/products/product-handle"
                className="w-full border rounded-lg px-md py-sm text-body-sm"
              />
            </label>
            <label className="block">
              <span className="text-label-sm block mb-xs">Design SKU prefix</span>
              <input
                value={skuPrefix}
                onChange={e => setSkuPrefix(e.target.value)}
                placeholder="POMO-GIFT-001"
                className="w-full border rounded-lg px-md py-sm text-body-sm"
              />
            </label>
            <label className="block">
              <span className="text-label-sm block mb-xs">Output status</span>
              <select value={status} onChange={e => setStatus(e.target.value as any)} className="w-full border rounded-lg px-md py-sm text-body-sm">
                <option value="draft">draft</option>
                <option value="active">active</option>
                <option value="archived">archived</option>
              </select>
            </label>
            <button disabled={loading || !url} className="bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md disabled:opacity-50">
              {loading ? 'Crawling...' : 'Crawl & Map'}
            </button>
          </div>
          {error && <p className="text-error text-body-sm mt-md">{error}</p>}
        </form>

        {result && (
          <section className="space-y-lg">
            <div className="bg-surface-container-lowest rounded-xl border border-outline-variant/20 p-lg flex gap-lg items-start">
              {result.product.image && (
                <img src={result.product.image} alt="" className="w-28 h-28 rounded-lg object-cover border border-outline-variant/20" />
              )}
              <div className="flex-1">
                <h2 className="text-headline-sm text-primary">{result.product.title}</h2>
                <p className="text-body-sm text-on-surface-variant mt-xs">
                  {result.product.vendor || '-'} · {result.product.productType || '-'} · {result.product.variantCount} variants · {result.product.imageCount} images
                </p>
                {tags && <p className="text-label-sm text-on-surface-variant mt-xs">Tags: {tags}</p>}
              </div>
              <div className="text-right">
                <p className={`text-label-md ${result.unmappedCount ? 'text-error' : 'text-on-tertiary-container'}`}>
                  {result.unmappedCount ? `${result.unmappedCount} unmapped` : 'All variants mapped'}
                </p>
                <button onClick={downloadCsv} className="mt-sm bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md">
                  Download Shopify CSV
                </button>
              </div>
            </div>

            <div className="bg-surface-container-lowest rounded-xl border border-outline-variant/20 overflow-hidden">
              <table className="w-full text-body-sm">
                <thead className="bg-surface-container">
                  <tr className="text-left">
                    <th className="px-md py-sm">Variant</th>
                    <th className="px-md py-sm">Design SKU</th>
                    <th className="px-md py-sm">Supplier</th>
                    <th className="px-md py-sm">Supplier SKU</th>
                    <th className="px-md py-sm text-right">Base cost</th>
                    <th className="px-md py-sm">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {result.mappings.map(m => (
                    <tr key={m.variantId} className={`border-t border-outline-variant/20 ${!m.supplierSku ? 'bg-error/5' : ''}`}>
                      <td className="px-md py-sm">{m.variantTitle || '-'}</td>
                      <td className="px-md py-sm font-mono text-xs">{m.designSku}</td>
                      <td className="px-md py-sm">{m.supplierName ?? <span className="text-error">unmapped</span>}</td>
                      <td className="px-md py-sm font-mono text-xs">{m.supplierSku ?? '-'}</td>
                      <td className="px-md py-sm text-right">{m.baseCost == null ? '-' : `$${m.baseCost.toFixed(2)}`}</td>
                      <td className="px-md py-sm text-xs text-on-surface-variant">{m.reasons.join(', ') || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="bg-surface-container-lowest rounded-xl border border-outline-variant/20 p-lg">
              <h2 className="text-headline-sm mb-md">CSV Preview</h2>
              <pre className="bg-surface-container rounded-lg p-sm text-label-sm overflow-x-auto whitespace-pre">
                {result.csv.split('\n').slice(0, 8).join('\n')}
              </pre>
            </div>
          </section>
        )}
      </main>
    </div>
  )
}
