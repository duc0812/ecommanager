'use client'
import { useEffect, useState } from 'react'
import Sidebar from '@/components/Sidebar'

type Status = { connected: boolean; shop?: string; connectedAt?: string }

const LS_KEY = 'shopify_app_creds_v1'

export default function SetupPage() {
  const [status, setStatus] = useState<Status | null>(null)
  const [shop, setShop] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [apiSecret, setApiSecret] = useState('')
  const [showSecret, setShowSecret] = useState(false)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    try {
      const saved = localStorage.getItem(LS_KEY)
      if (saved) {
        const p = JSON.parse(saved)
        if (p.shop) setShop(p.shop)
        if (p.apiKey) setApiKey(p.apiKey)
        if (p.apiSecret) setApiSecret(p.apiSecret)
      }
    } catch {}
    fetch('/api/auth/status').then(r => r.json()).then(d => setStatus(d.shopify)).catch(() => setStatus({ connected: false }))
  }, [])

  async function connect() {
    const s = shop.trim(), k = apiKey.trim(), sec = apiSecret.trim()
    if (!s || !k || !sec) { alert('Vui lòng điền đầy đủ Shop Domain, API Key và API Secret.'); return }
    setLoading(true)
    try { localStorage.setItem(LS_KEY, JSON.stringify({ shop: s, apiKey: k, apiSecret: sec })) } catch {}
    try {
      await fetch('/api/auth/shopify-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: k, apiSecret: sec, shop: s }),
      })
      window.location.href = `/api/auth/shopify?shop=${encodeURIComponent(s)}`
    } catch {
      setLoading(false)
      alert('Lỗi kết nối server.')
    }
  }

  async function disconnect() {
    await fetch('/api/auth/status', { method: 'DELETE' }).catch(() => {})
    localStorage.removeItem(LS_KEY)
    setStatus({ connected: false })
    setShop(''); setApiKey(''); setApiSecret('')
  }

  const canConnect = shop.trim() && apiKey.trim() && apiSecret.trim()

  return (
    <div className="flex min-h-screen bg-surface">
      <Sidebar />

      <main className="ml-[280px] flex-1 p-xl">
        <header className="mb-xl">
          <h2 className="text-display-md font-bold text-primary">Setup</h2>
          <p className="text-on-surface-variant text-body-md mt-xs">Kết nối cửa hàng Shopify của bạn</p>
        </header>

        <div className="grid grid-cols-12 gap-lg">
          {/* Left: connection status */}
          <div className="col-span-12 lg:col-span-4 space-y-lg">
            <div className="bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20 p-lg">
              <h3 className="text-headline-sm text-primary mb-lg">Cửa hàng đã kết nối</h3>

              {status === null ? (
                <div className="flex items-center gap-sm text-on-surface-variant text-body-sm">
                  <span className="material-symbols-outlined text-[16px] animate-spin">sync</span>
                  Đang kiểm tra...
                </div>
              ) : status.connected ? (
                <div className="p-md bg-secondary/5 border-2 border-secondary rounded-lg">
                  <div className="flex items-center gap-md mb-md">
                    <div className="w-12 h-12 bg-white rounded-lg flex items-center justify-center border border-outline-variant/30">
                      <span className="material-symbols-outlined text-secondary text-[28px]">shopping_bag</span>
                    </div>
                    <div className="flex-1">
                      <h4 className="text-label-md text-primary">{status.shop}</h4>
                      <div className="flex items-center gap-xs text-on-tertiary-container text-label-sm">
                        <span className="w-2 h-2 rounded-full bg-on-tertiary-container animate-pulse inline-block"></span>
                        Connected
                      </div>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-xs pt-sm border-t border-secondary/20">
                    <a href="/shopify" className="text-secondary text-label-sm hover:underline py-xs">Xem Finance</a>
                    <button onClick={disconnect} className="text-error text-label-sm hover:underline py-xs text-right">Ngắt kết nối</button>
                  </div>
                </div>
              ) : (
                <div className="p-md bg-surface-container rounded-lg border border-outline-variant/20 text-center">
                  <span className="material-symbols-outlined text-on-surface-variant text-[40px]">store_off</span>
                  <p className="text-body-sm text-on-surface-variant mt-sm">Chưa kết nối store nào</p>
                </div>
              )}
            </div>

            {/* Info card */}
            <div className="bg-primary text-on-primary p-lg rounded-xl shadow-lg relative overflow-hidden">
              <div className="relative z-10">
                <p className="text-label-md opacity-70 mb-xs">OAuth 2.0</p>
                <h3 className="text-headline-sm font-bold mb-md">Kết nối an toàn</h3>
                <p className="text-body-sm opacity-80">Credentials được lưu trong database của app. Không ghi vào file cấu hình.</p>
              </div>
              <div className="absolute -right-6 -bottom-6 opacity-10">
                <span className="material-symbols-outlined text-[100px]">lock</span>
              </div>
            </div>
          </div>

          {/* Right: form */}
          <div className="col-span-12 lg:col-span-8">
            <div className="bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20 overflow-hidden">
              <div className="flex items-center gap-sm px-lg py-md border-b border-outline-variant/20">
                <div className="w-8 h-8 rounded-lg bg-[#96bf48] flex items-center justify-center">
                  <span className="material-symbols-outlined text-white text-[18px]">shopping_bag</span>
                </div>
                <h3 className="text-headline-sm text-primary">Shopify Partner App</h3>
                {status?.connected && (
                  <span className="ml-auto bg-on-tertiary-container/15 text-on-tertiary-container px-sm py-xs rounded-full text-label-sm">
                    ✓ Connected
                  </span>
                )}
              </div>

              <div className="p-lg space-y-lg">
                {status?.connected ? (
                  <div className="text-center py-xl">
                    <span className="material-symbols-outlined text-[64px] text-on-tertiary-container">check_circle</span>
                    <h3 className="text-headline-sm text-primary mt-md mb-sm">Đã kết nối thành công</h3>
                    <p className="text-body-md text-on-surface-variant mb-xl">{status.shop}</p>
                    <div className="flex gap-sm justify-center">
                      <a href="/shopify" className="bg-secondary text-on-secondary px-xl py-md rounded-lg text-label-md hover:opacity-90 transition-opacity">
                        Xem Finance →
                      </a>
                      <button onClick={disconnect} className="border border-outline-variant text-on-surface-variant px-xl py-md rounded-lg text-label-md hover:bg-surface-container transition-colors">
                        Ngắt kết nối
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-lg">
                      <div className="space-y-xs">
                        <label className="block text-label-sm text-on-surface-variant uppercase tracking-wider">
                          Shop Domain <span className="text-error">*</span>
                        </label>
                        <input
                          type="text"
                          value={shop}
                          onChange={e => setShop(e.target.value)}
                          placeholder="your-store.myshopify.com"
                          className="w-full bg-surface-container border border-outline-variant/30 rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-secondary focus:border-secondary outline-none transition-all"
                        />
                      </div>
                      <div className="space-y-xs">
                        <label className="block text-label-sm text-on-surface-variant uppercase tracking-wider">
                          API Key (Client ID) <span className="text-error">*</span>
                        </label>
                        <input
                          type="text"
                          value={apiKey}
                          onChange={e => setApiKey(e.target.value)}
                          placeholder="Từ partners.shopify.com"
                          autoComplete="off"
                          className="w-full bg-surface-container border border-outline-variant/30 rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-secondary focus:border-secondary outline-none transition-all"
                        />
                      </div>
                    </div>

                    <div className="space-y-xs">
                      <label className="block text-label-sm text-on-surface-variant uppercase tracking-wider">
                        API Secret (Client Secret) <span className="text-error">*</span>
                      </label>
                      <div className="relative">
                        <input
                          type={showSecret ? 'text' : 'password'}
                          value={apiSecret}
                          onChange={e => setApiSecret(e.target.value)}
                          placeholder="Client secret từ Partner Dashboard"
                          autoComplete="off"
                          className="w-full bg-surface-container border border-outline-variant/30 rounded-lg px-md py-sm pr-10 text-body-md focus:ring-2 focus:ring-secondary focus:border-secondary outline-none transition-all"
                        />
                        <button
                          type="button"
                          onClick={() => setShowSecret(s => !s)}
                          className="absolute right-md top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-primary"
                        >
                          <span className="material-symbols-outlined text-[20px]">{showSecret ? 'visibility_off' : 'visibility'}</span>
                        </button>
                      </div>
                    </div>

                    <div className="bg-amber-50 border border-amber-200 rounded-lg p-md space-y-xs">
                      <p className="text-label-md text-amber-800 flex items-center gap-xs">
                        <span className="material-symbols-outlined text-[16px]">info</span>
                        Chưa có Partner App?
                      </p>
                      <ol className="text-body-sm text-amber-700 space-y-xs ml-md list-decimal">
                        <li>Vào <strong>partners.shopify.com</strong> → Apps → Create app</li>
                        <li>Trong App setup, thêm Redirect URI:<br />
                          <code className="text-xs bg-amber-100 rounded px-xs py-xs inline-block mt-xs break-all">
                            http://localhost:3000/api/auth/shopify/callback
                          </code>
                        </li>
                        <li>Copy API Key và API Secret vào form trên.</li>
                      </ol>
                    </div>

                    <button
                      onClick={connect}
                      disabled={loading || !canConnect}
                      className="w-full bg-secondary text-on-secondary py-md rounded-lg text-label-md font-semibold hover:opacity-90 transition-opacity disabled:opacity-40 flex items-center justify-center gap-sm"
                    >
                      <span className={`material-symbols-outlined text-[20px] ${loading ? 'animate-spin' : ''}`}>
                        {loading ? 'sync' : 'link'}
                      </span>
                      {loading ? 'Đang mở Shopify...' : 'Kết nối Shopify OAuth'}
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}
