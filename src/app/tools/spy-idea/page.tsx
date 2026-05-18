'use client'

import { FormEvent, useEffect, useState } from 'react'
import Sidebar from '@/components/Sidebar'
import { RoleGate } from '@/components/RoleGate'

type SpyProduct = {
  id?: number
  title: string
  handle: string
  url: string
  image: string | null
  listedAt: string | null
  dateSource: string | null
  createdAt: string | null
  publishedAt: string | null
  updatedAt: string | null
  vendor: string | null
  productType: string | null
  tags: string[]
  tagsPreview: string[]
  variantCount: number
  availableVariantCount: number
  price: string | null
  description: string
  cacheKey: string
}

type SpyDomainResult = {
  domain: string
  endpoint: string
  fetchedAt: string
  totalScanned: number
  recentCount: number
  newCount: number
  cachedOldCount: number
  since: string
  cacheExpiresAt: string | null
  products: SpyProduct[]
  cachedProducts: SpyProduct[]
  error: string | null
}

type SpyResult = {
  fetchedAt: string
  domainCount: number
  totalScanned: number
  recentCount: number
  newCount: number
  cachedOldCount: number
  results: SpyDomainResult[]
  cachedProducts: SpyProduct[]
}

const SAVED_DOMAINS_KEY = 'spy-idea:saved-domains'

function parseDomainInput(value: string) {
  return Array.from(
    new Set(
      value
        .split(/\r?\n|,/)
        .map(domain => domain.trim())
        .filter(Boolean),
    ),
  ).slice(0, 10)
}

function formatDate(value: string | null) {
  if (!value) return '-'
  return new Intl.DateTimeFormat('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

export default function SpyIdeaPage() {
  const [domains, setDomains] = useState('')
  const [savedDomains, setSavedDomains] = useState<string[]>([])
  const [result, setResult] = useState<SpyResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<'new' | 'all'>('new')

  const domainCount = parseDomainInput(domains).length

  useEffect(() => {
    const saved = JSON.parse(localStorage.getItem(SAVED_DOMAINS_KEY) || '[]')
    if (Array.isArray(saved)) {
      const normalized = saved.map(domain => String(domain).trim()).filter(Boolean).slice(0, 10)
      setSavedDomains(normalized)
      if (normalized.length > 0) setDomains(current => current.trim() ? current : normalized.join('\n'))
    }
  }, [])

  function saveDomains() {
    const next = parseDomainInput(domains)
    setSavedDomains(next)
    localStorage.setItem(SAVED_DOMAINS_KEY, JSON.stringify(next))
  }

  function removeSavedDomain(domain: string) {
    const next = savedDomains.filter(item => item !== domain)
    setSavedDomains(next)
    localStorage.setItem(SAVED_DOMAINS_KEY, JSON.stringify(next))
    setDomains(current => parseDomainInput(current).filter(item => item !== domain).join('\n'))
  }

  function loadSavedDomains() {
    setDomains(savedDomains.join('\n'))
  }

  async function scan(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!domains.trim()) return
    setLoading(true)
    setError(null)
    setResult(null)

    try {
      const res = await fetch('/api/tools/spy-idea', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: domains }),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json.error || 'Could not scan this domain')
        return
      }
      setResult(json)
      setViewMode(json.newCount > 0 ? 'new' : 'all')
    } catch {
      setError('Could not connect to spy service')
    } finally {
      setLoading(false)
    }
  }

  return (
    <RoleGate>
      <div className="flex min-h-screen bg-surface">
        <Sidebar />
        <main className="ml-[280px] flex-1 p-xl">
          <header className="mb-xl">
            <p className="text-label-sm uppercase tracking-wider text-on-surface-variant">Tools</p>
            <h2 className="text-display-md font-bold text-primary">Spy Idea</h2>
            <p className="mt-xs text-body-md text-on-surface-variant">
              Quet toi da 10 Shopify domains, loc san pham 7 ngay gan nhat va chi hien idea moi trong cache 24h.
            </p>
          </header>

          <section className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-lg">
            <form onSubmit={scan} className="grid grid-cols-1 gap-md lg:grid-cols-[1fr_auto]">
              <div className="relative">
                <span className="material-symbols-outlined pointer-events-none absolute left-md top-md text-[20px] text-on-surface-variant">
                  travel_explore
                </span>
                <textarea
                  value={domains}
                  onChange={e => setDomains(e.target.value)}
                  placeholder={'familystore.com\nexample-store.com\nanother-store.com'}
                  rows={5}
                  className="w-full resize-y rounded-lg border border-outline-variant/30 bg-surface-container px-md py-sm pl-[44px] text-body-md outline-none focus:border-secondary"
                />
                <p className="mt-xs text-body-sm text-on-surface-variant">{Math.min(domainCount, 10)}/10 domains will be scanned sequentially.</p>
              </div>
              <div className="flex flex-wrap gap-sm lg:flex-col lg:self-start">
                <button
                  disabled={loading || !domains.trim()}
                  className="inline-flex h-[46px] items-center justify-center gap-sm rounded-lg bg-secondary px-lg text-label-md font-semibold text-on-secondary disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span className="material-symbols-outlined text-[18px]">{loading ? 'progress_activity' : 'search'}</span>
                  {loading ? 'Scanning' : 'Spy domains'}
                </button>
                <button
                  type="button"
                  onClick={saveDomains}
                  disabled={!domains.trim()}
                  className="inline-flex h-[46px] items-center justify-center gap-sm rounded-lg bg-surface-container px-lg text-label-md font-semibold text-on-surface-variant hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span className="material-symbols-outlined text-[18px]">bookmark</span>
                  Save domains
                </button>
              </div>
            </form>
            {error && <p className="mt-md text-body-sm text-error">{error}</p>}
            {savedDomains.length > 0 && (
              <div className="mt-md border-t border-outline-variant/20 pt-md">
                <div className="mb-sm flex items-center justify-between gap-md">
                  <p className="text-label-sm uppercase tracking-wider text-on-surface-variant">Saved competitors</p>
                  <button type="button" onClick={loadSavedDomains} className="text-label-sm text-secondary hover:underline">
                    Load saved list
                  </button>
                </div>
                <div className="flex flex-wrap gap-xs">
                  {savedDomains.map(domain => (
                    <span key={domain} className="inline-flex items-center gap-xs rounded-full bg-secondary/10 px-sm py-xs text-label-sm text-secondary">
                      {domain}
                      <button type="button" onClick={() => removeSavedDomain(domain)} className="text-secondary/70 hover:text-secondary" title="Remove domain">
                        <span className="material-symbols-outlined text-[12px]">close</span>
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </section>

          {result && (
            <>
              <div className="mt-xl grid grid-cols-1 gap-lg md:grid-cols-5">
                <Stat title="Domains" value={String(result.domainCount)} />
                <Stat title="Products scanned" value={String(result.totalScanned)} />
                <Stat title="Recent 7 days" value={String(result.recentCount)} />
                <Stat title="New ideas" value={String(result.newCount)} />
                <Stat title="Cached old" value={String(result.cachedOldCount)} />
              </div>

              <section className="mt-xl">
                <div className="mb-md flex flex-wrap items-center justify-between gap-md">
                  <div>
                    <h3 className="text-headline-sm text-primary">{viewMode === 'new' ? 'New Idea Cards' : 'All Recent Ideas'}</h3>
                    <p className="text-body-sm text-on-surface-variant">Fetched {formatDate(result.fetchedAt)}</p>
                  </div>
                  <div className="inline-flex rounded-lg bg-surface-container p-xs">
                    <button
                      type="button"
                      onClick={() => setViewMode('new')}
                      className={`rounded-md px-md py-xs text-label-sm ${viewMode === 'new' ? 'bg-secondary text-on-secondary' : 'text-on-surface-variant hover:bg-surface-container-high'}`}
                    >
                      New only
                    </button>
                    <button
                      type="button"
                      onClick={() => setViewMode('all')}
                      className={`rounded-md px-md py-xs text-label-sm ${viewMode === 'all' ? 'bg-secondary text-on-secondary' : 'text-on-surface-variant hover:bg-surface-container-high'}`}
                    >
                      All recent
                    </button>
                  </div>
                </div>
                {result.results.map(domainResult => (
                  <DomainSection key={domainResult.domain} result={domainResult} viewMode={viewMode} />
                ))}
              </section>
            </>
          )}
        </main>
      </div>
    </RoleGate>
  )
}

function DomainSection({ result, viewMode }: { result: SpyDomainResult; viewMode: 'new' | 'all' }) {
  const products = viewMode === 'new' ? result.products : result.cachedProducts

  return (
    <section className="mb-xl">
      <div className="mb-sm flex flex-wrap items-center gap-sm">
        <h4 className="text-headline-sm text-primary">{result.domain}</h4>
        <span className="rounded-full bg-secondary/10 px-sm py-xs text-label-sm text-secondary">{result.newCount} new</span>
        <span className="rounded-full bg-surface-container px-sm py-xs text-label-sm text-on-surface-variant">{result.cachedOldCount} cached old</span>
        {result.error && <span className="rounded-full bg-error/10 px-sm py-xs text-label-sm text-error">{result.error}</span>}
      </div>
      <p className="mb-md break-all text-body-sm text-on-surface-variant">
        Source: {result.endpoint}
        {result.cacheExpiresAt ? ` | Cache reset: ${formatDate(result.cacheExpiresAt)}` : ''}
      </p>
      {products.length > 0 ? (
        <div className="grid grid-cols-1 gap-md sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
          {products.map(product => (
            <ProductCard key={`${result.domain}-${product.cacheKey}`} product={product} />
          ))}
        </div>
      ) : (
        <div className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-lg text-center">
          <span className="material-symbols-outlined text-[28px] text-on-surface-variant">inventory_2</span>
          <p className="mt-xs text-body-md text-primary">{viewMode === 'new' ? 'Khong co idea moi' : 'Chua co idea trong cache'}</p>
          <p className="mt-xs text-body-sm text-on-surface-variant">
            {viewMode === 'new'
              ? 'Chuyen sang All recent de xem lai idea da quet trong 24h.'
              : 'Hay scan domain nay de tao cache tam thoi.'}
          </p>
        </div>
      )}
    </section>
  )
}

function Stat({ title, value }: { title: string; value: string }) {
  return (
    <div className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-lg">
      <p className="text-label-sm uppercase tracking-wider text-on-surface-variant">{title}</p>
      <p className="mt-xs text-stats-lg text-primary">{value}</p>
    </div>
  )
}

function ProductCard({ product }: { product: SpyProduct }) {
  return (
    <article className="overflow-hidden rounded-xl border border-outline-variant/20 bg-surface-container-lowest">
      <div className="aspect-square bg-surface-container-low">
        {product.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={product.image} alt={product.title} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center text-on-surface-variant">
            <span className="material-symbols-outlined text-[42px]">image_not_supported</span>
          </div>
        )}
      </div>
      <div className="p-md">
        <div className="mb-sm flex items-start gap-sm">
          <div className="min-w-0 flex-1">
            <a href={product.url} target="_blank" rel="noreferrer" className="line-clamp-2 block min-h-[40px] text-label-md font-bold leading-snug text-primary hover:text-secondary" title={product.title}>
              {product.title}
            </a>
            <p className="mt-xs text-body-sm text-on-surface-variant">Ngay dang: {formatDate(product.listedAt)}</p>
          </div>
          <a
            href={product.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-lg bg-surface-container text-secondary hover:bg-surface-container-high"
            title="Open product"
          >
            <span className="material-symbols-outlined text-[18px]">open_in_new</span>
          </a>
        </div>

        <div className="mb-sm grid grid-cols-2 gap-xs text-body-sm">
          <Info label="Price" value={product.price || '-'} />
          <Info label="Variants" value={`${product.availableVariantCount}/${product.variantCount || 0} active`} />
        </div>

        {(product.vendor || product.productType) && (
          <p className="mb-sm truncate text-body-sm text-on-surface-variant" title={[product.vendor, product.productType].filter(Boolean).join(' - ')}>
            {[product.vendor, product.productType].filter(Boolean).join(' - ')}
          </p>
        )}

        {product.tagsPreview.length > 0 && (
          <div className="flex flex-wrap gap-xs">
            {product.tagsPreview.slice(0, 4).map(tag => (
              <span key={tag} className="rounded-full bg-secondary/10 px-sm py-xs text-label-sm text-secondary">
                {tag}
              </span>
            ))}
            {product.tags.length > 4 && (
              <span className="rounded-full bg-surface-container px-sm py-xs text-label-sm text-on-surface-variant">
                +{product.tags.length - 4}
              </span>
            )}
          </div>
        )}
      </div>
    </article>
  )
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-surface-container-low p-sm">
      <p className="text-label-sm uppercase tracking-wider text-on-surface-variant">{label}</p>
      <p className="mt-xs truncate text-label-md text-primary" title={value}>
        {value}
      </p>
    </div>
  )
}
