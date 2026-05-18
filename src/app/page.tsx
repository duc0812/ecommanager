'use client'
import { useEffect, useState } from 'react'
import Sidebar from '@/components/Sidebar'

type RecentPayout = {
  id: number
  date: string
  amount: number
  currency: string
  status: string
}

type RecentBilling = {
  id: string
  billingDate: string
  amount: number
  currency: string
  chargeType: string | null
  adAccountId: string
}

type ProjectSummary = {
  id: string
  name: string
  startDate: string
  staffCount: number
  monthlyCost: number
}

type OverviewData = {
  shopify: { totalRevenue: number; payoutCount: number; recentPayouts: RecentPayout[] }
  meta: { totalSpend: number; billingCount: number; recentBillings: RecentBilling[] }
  projects: { count: number; list: ProjectSummary[] }
  staff: { count: number; totalMonthlyCost: number }
  netCashflow: number
  error?: string
}

function fmtUSD(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(n)
}

function StatCard({
  label, value, icon, accent, positive, negative,
}: {
  label: string; value: string; icon: string; accent?: boolean; positive?: boolean; negative?: boolean
}) {
  const bg = accent ? 'bg-primary text-on-primary' : 'bg-surface-container-lowest'
  const labelColor = accent ? 'text-on-primary/60' : 'text-on-surface-variant'
  const iconColor = accent ? 'text-on-primary/40' : 'text-secondary'
  const valueColor = positive ? 'text-on-tertiary-container' : negative ? 'text-error' : accent ? 'text-on-primary' : 'text-primary'

  return (
    <div className={`rounded-xl p-lg shadow-card border border-outline-variant/20 ${bg}`}>
      <div className="flex items-center justify-between mb-sm">
        <span className={`text-label-sm uppercase tracking-wider ${labelColor}`}>{label}</span>
        <span className={`material-symbols-outlined text-[18px] ${iconColor}`}>{icon}</span>
      </div>
      <div className={`text-stats-lg font-bold ${valueColor}`}>{value}</div>
    </div>
  )
}

export default function OverviewPage() {
  const [data, setData] = useState<OverviewData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/overview')
      .then(r => r.json())
      .then((d: OverviewData) => { setData(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  return (
    <div className="flex min-h-screen bg-surface">
      <Sidebar />
      <main className="ml-[280px] flex-1 p-xl">
        <header className="mb-xl">
          <h2 className="text-display-md font-bold text-primary">Overview</h2>
          <p className="text-on-surface-variant text-body-md mt-xs">Tổng quan cashflow & hiệu quả kinh doanh</p>
        </header>

        {loading && (
          <div className="flex items-center justify-center py-3xl text-on-surface-variant gap-sm">
            <span className="material-symbols-outlined animate-spin text-[24px]">sync</span>
            <span className="text-body-md">Đang tải dữ liệu...</span>
          </div>
        )}

        {data?.error && (
          <div className="bg-error-container/20 border border-error/20 rounded-xl px-lg py-md flex items-center gap-md mb-xl">
            <span className="material-symbols-outlined text-error">error</span>
            <p className="text-body-sm">{data.error}</p>
          </div>
        )}

        {data && !data.error && (
          <>
            {/* Top stat cards */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-lg mb-xl">
              <StatCard label="Total Revenue" value={fmtUSD(data.shopify.totalRevenue)} icon="account_balance_wallet" positive />
              <StatCard label="Total Ad Spend" value={fmtUSD(data.meta.totalSpend)} icon="campaign" negative />
              <StatCard
                label="Net Cashflow"
                value={fmtUSD(data.netCashflow)}
                icon="trending_up"
                accent
                positive={data.netCashflow >= 0}
                negative={data.netCashflow < 0}
              />
              <StatCard label="Active Projects" value={String(data.projects.count)} icon="folder_open" />
            </div>

            {/* Secondary stats */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-lg mb-xl">
              <StatCard label="Total Payouts" value={String(data.shopify.payoutCount)} icon="receipt_long" />
              <StatCard label="Meta Billings" value={String(data.meta.billingCount)} icon="receipt" />
              <StatCard label="Staff Count" value={String(data.staff.count)} icon="group" />
              <StatCard label="Monthly Staff Cost" value={fmtUSD(data.staff.totalMonthlyCost)} icon="payments" />
            </div>

            {/* Middle: recent payouts + recent billings */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-xl mb-xl">
              {/* Recent Payouts */}
              <div className="bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20 overflow-hidden">
                <div className="flex items-center gap-sm px-lg py-md border-b border-outline-variant/20">
                  <span className="material-symbols-outlined text-secondary">payments</span>
                  <h3 className="text-headline-sm text-primary">Recent Payouts</h3>
                  <a href="/shopify" className="ml-auto text-secondary text-label-sm hover:underline flex items-center gap-xs">
                    Xem tất cả
                    <span className="material-symbols-outlined text-[14px]">chevron_right</span>
                  </a>
                </div>
                {data.shopify.recentPayouts.length === 0 ? (
                  <div className="px-lg py-xl text-center text-on-surface-variant text-body-sm">Chưa có dữ liệu</div>
                ) : (
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-outline-variant/10 bg-surface-container-low">
                        <th className="text-left px-lg py-sm text-label-sm text-on-surface-variant">Date</th>
                        <th className="text-left px-lg py-sm text-label-sm text-on-surface-variant">Amount</th>
                        <th className="text-left px-lg py-sm text-label-sm text-on-surface-variant">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.shopify.recentPayouts.map(p => (
                        <tr key={p.id} className="border-b border-outline-variant/10 hover:bg-surface-container-low/50 transition-colors">
                          <td className="px-lg py-sm text-body-sm text-on-surface-variant">{p.date}</td>
                          <td className="px-lg py-sm text-label-md font-bold text-on-tertiary-container">{fmtUSD(p.amount)}</td>
                          <td className="px-lg py-sm">
                            <span className="bg-on-tertiary-container/15 text-on-tertiary-container px-sm py-xs rounded-full text-label-sm">
                              {p.status}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              {/* Recent Meta Billings */}
              <div className="bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20 overflow-hidden">
                <div className="flex items-center gap-sm px-lg py-md border-b border-outline-variant/20">
                  <span className="material-symbols-outlined text-secondary">campaign</span>
                  <h3 className="text-headline-sm text-primary">Recent Meta Billings</h3>
                  <a href="/finance/meta" className="ml-auto text-secondary text-label-sm hover:underline flex items-center gap-xs">
                    Xem tất cả
                    <span className="material-symbols-outlined text-[14px]">chevron_right</span>
                  </a>
                </div>
                {data.meta.recentBillings.length === 0 ? (
                  <div className="px-lg py-xl text-center text-on-surface-variant text-body-sm">Chưa có dữ liệu</div>
                ) : (
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-outline-variant/10 bg-surface-container-low">
                        <th className="text-left px-lg py-sm text-label-sm text-on-surface-variant">Date</th>
                        <th className="text-left px-lg py-sm text-label-sm text-on-surface-variant">Amount</th>
                        <th className="text-left px-lg py-sm text-label-sm text-on-surface-variant">Type</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.meta.recentBillings.map(b => (
                        <tr key={b.id} className="border-b border-outline-variant/10 hover:bg-surface-container-low/50 transition-colors">
                          <td className="px-lg py-sm text-body-sm text-on-surface-variant">{b.billingDate}</td>
                          <td className="px-lg py-sm text-label-md font-bold text-error">-{fmtUSD(b.amount)}</td>
                          <td className="px-lg py-sm text-body-sm text-on-surface-variant">{b.chargeType ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>

            {/* Projects summary */}
            <div className="bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20 overflow-hidden">
              <div className="flex items-center gap-sm px-lg py-md border-b border-outline-variant/20">
                <span className="material-symbols-outlined text-secondary">folder_open</span>
                <h3 className="text-headline-sm text-primary">Projects</h3>
                <a href="/projects" className="ml-auto text-secondary text-label-sm hover:underline flex items-center gap-xs">
                  Dashboard
                  <span className="material-symbols-outlined text-[14px]">chevron_right</span>
                </a>
              </div>
              {data.projects.list.length === 0 ? (
                <div className="px-lg py-xl text-center text-on-surface-variant text-body-sm">
                  Chưa có project nào.{' '}
                  <a href="/setup/projects" className="text-secondary hover:underline">Tạo project</a>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-lg p-lg">
                  {data.projects.list.map(p => (
                    <a
                      key={p.id}
                      href="/projects"
                      className="block bg-surface-container rounded-xl p-lg border border-outline-variant/20 hover:border-secondary/40 hover:shadow-card transition-all"
                    >
                      <div className="flex items-start justify-between mb-sm">
                        <h4 className="text-headline-sm text-primary">{p.name}</h4>
                        <span className="material-symbols-outlined text-[18px] text-secondary">analytics</span>
                      </div>
                      <p className="text-label-sm text-on-surface-variant mb-md">
                        Start: {new Date(p.startDate).toLocaleDateString('vi-VN')}
                      </p>
                      <div className="flex items-center justify-between">
                        <span className="flex items-center gap-xs text-body-sm text-on-surface-variant">
                          <span className="material-symbols-outlined text-[14px]">group</span>
                          {p.staffCount} staff
                        </span>
                        <span className="text-label-md font-bold text-primary">
                          {fmtUSD(p.monthlyCost)}<span className="text-label-sm font-normal text-on-surface-variant">/mo</span>
                        </span>
                      </div>
                    </a>
                  ))}
                </div>
              )}
            </div>
          </>
        )}

        {!loading && !data && (
          <div className="flex flex-col items-center justify-center py-3xl text-center">
            <div className="w-16 h-16 bg-secondary/10 rounded-2xl flex items-center justify-center mb-lg">
              <span className="material-symbols-outlined text-[40px] text-secondary">dashboard</span>
            </div>
            <h3 className="text-headline-sm text-primary mb-sm">Không tải được dữ liệu</h3>
            <p className="text-body-md text-on-surface-variant">Kiểm tra server và thử lại.</p>
          </div>
        )}
      </main>
    </div>
  )
}
