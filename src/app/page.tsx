'use client'
import { useEffect, useState } from 'react'
import Sidebar from '@/components/Sidebar'

type PeriodMetrics = {
  period: string
  label: string
  from: string
  to: string
  orders: number
  revenue: number
  adSpend: number
  orderProfit: number
  netProfit: number
  roas: number
  avgMargin: number
  avgOrderValue: number
  unfulfilledOrders: number
}

type ChartPoint = { date: string; revenue: number; adSpend: number }

type RecentPayout = { id: number; date: string; amount: number; currency: string; status: string }
type RecentBilling = { id: string; billingDate: string; amount: number; currency: string; chargeType: string | null }
type ProjectSummary = { id: string; name: string; startDate: string; staffCount: number; monthlyCost: number }

type OverviewData = {
  shopify: { totalRevenue: number; payoutCount: number; recentPayouts: RecentPayout[] }
  meta: { totalSpend: number; billingCount: number; recentBillings: RecentBilling[] }
  projects: { count: number; list: ProjectSummary[] }
  staff: { count: number; totalMonthlyCost: number }
  netCashflow: number
  periodMetrics: PeriodMetrics | null
  chartData: ChartPoint[]
  error?: string
}

const PERIODS = [
  { key: 'today', label: 'Hôm nay' },
  { key: 'this-week', label: 'Tuần này' },
  { key: 'this-month', label: 'Tháng này' },
  { key: 'all', label: 'All time' },
]

function fmtUSD(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(n || 0)
}

function fmtNum(n: number) {
  return new Intl.NumberFormat('en-US').format(n || 0)
}

export default function OverviewPage() {
  const [period, setPeriod] = useState<string>('today')
  const [data, setData] = useState<OverviewData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    fetch(`/api/overview?period=${period}`)
      .then(r => r.json())
      .then((d: OverviewData) => { setData(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [period])

  const pm = data?.periodMetrics
  const isAllTime = period === 'all'

  return (
    <div className="flex min-h-screen bg-surface">
      <Sidebar />
      <main className="ml-[280px] flex-1 p-xl">
        <div className="flex items-center justify-between mb-lg flex-wrap gap-sm">
          <div>
            <h2 className="text-display-md font-bold text-primary">Tổng quan</h2>
            <p className="text-on-surface-variant text-body-md mt-xs">Lợi nhuận & Hiệu quả kinh doanh</p>
          </div>
        </div>

        {/* Period tabs */}
        <div className="flex gap-xs mb-xl flex-wrap">
          {PERIODS.map(p => (
            <button
              key={p.key}
              onClick={() => setPeriod(p.key)}
              className={`px-lg py-sm rounded-lg text-label-md font-semibold transition-all ${
                period === p.key
                  ? 'bg-secondary text-on-secondary shadow-sm'
                  : 'bg-surface-container text-on-surface-variant hover:bg-surface-container-high border border-outline-variant/20'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>

        {loading && (
          <div className="flex items-center justify-center py-3xl text-on-surface-variant gap-sm">
            <span className="material-symbols-outlined animate-spin text-[24px]">sync</span>
            <span className="text-body-md">Đang tải...</span>
          </div>
        )}

        {data && !data.error && !loading && (
          <>
            {/* Row 1: Hero + 3 stat cards */}
            {!isAllTime && pm ? (
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-lg mb-lg">
                <HeroCard
                  label={`Lợi nhuận ròng · ${pm.label}`}
                  value={fmtUSD(pm.netProfit)}
                  negative={pm.netProfit < 0}
                />
                <StatCard label="Đơn hàng" value={fmtNum(pm.orders)} sub={`AOV: ${fmtUSD(pm.avgOrderValue)}`} icon="shopping_bag" />
                <StatCard label="Doanh thu" value={fmtUSD(pm.revenue)} sub={`Margin ${pm.avgMargin.toFixed(1)}%`} icon="storefront" positive />
                <StatCard label="Ad Spend" value={fmtUSD(pm.adSpend)} sub={`ROAS ${pm.roas.toFixed(2)}x`} icon="campaign" negative />
              </div>
            ) : (
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-lg mb-lg">
                <StatCard label="Total Revenue" value={fmtUSD(data.shopify.totalRevenue)} icon="account_balance_wallet" positive />
                <StatCard label="Total Ad Spend" value={fmtUSD(data.meta.totalSpend)} icon="campaign" negative />
                <HeroCard label="Net Cashflow" value={fmtUSD(data.netCashflow)} negative={data.netCashflow < 0} />
                <StatCard label="Active Projects" value={fmtNum(data.projects.count)} icon="folder_open" />
              </div>
            )}

            {/* Row 2: Secondary metrics */}
            {!isAllTime && pm ? (
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-lg mb-xl">
                <MiniCard label="Order Profit" value={fmtUSD(pm.orderProfit)} color="positive" />
                <MiniCard label="ROAS" value={`${pm.roas.toFixed(2)}x`} color={pm.roas >= 3 ? 'positive' : 'warn'} />
                <MiniCard label="Avg Margin" value={`${pm.avgMargin.toFixed(1)}%`} color={pm.avgMargin >= 25 ? 'positive' : 'warn'} />
                <MiniCard label="Unfulfilled" value={fmtNum(pm.unfulfilledOrders)} color={pm.unfulfilledOrders > 0 ? 'warn' : 'neutral'} />
              </div>
            ) : (
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-lg mb-xl">
                <StatCard label="Total Payouts" value={fmtNum(data.shopify.payoutCount)} icon="receipt_long" />
                <StatCard label="Meta Billings" value={fmtNum(data.meta.billingCount)} icon="receipt" />
                <StatCard label="Staff Count" value={fmtNum(data.staff.count)} icon="group" />
                <StatCard label="Monthly Staff Cost" value={fmtUSD(data.staff.totalMonthlyCost)} icon="payments" />
              </div>
            )}

            {/* Revenue + Ad Spend Chart */}
            {data.chartData.length > 0 && (
              <div className="bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20 overflow-hidden mb-xl">
                <div className="flex items-center justify-between px-lg py-md border-b border-outline-variant/20">
                  <div className="flex items-center gap-sm">
                    <span className="material-symbols-outlined text-secondary">bar_chart</span>
                    <h3 className="text-headline-sm text-primary">Revenue vs Ad Spend (30 ngày)</h3>
                  </div>
                </div>
                <div className="p-lg">
                  <OverviewChart data={data.chartData} />
                </div>
              </div>
            )}

            {/* Recent Payouts + Billings */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-xl mb-xl">
              <div className="bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20 overflow-hidden">
                <div className="flex items-center gap-sm px-lg py-md border-b border-outline-variant/20">
                  <span className="material-symbols-outlined text-secondary">payments</span>
                  <h3 className="text-headline-sm text-primary">Recent Payouts</h3>
                  <a href="/shopify" className="ml-auto text-secondary text-label-sm hover:underline flex items-center gap-xs">
                    Xem tất cả <span className="material-symbols-outlined text-[14px]">chevron_right</span>
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
                        <tr key={p.id} className="border-b border-outline-variant/10 hover:bg-surface-container-low/50">
                          <td className="px-lg py-sm text-body-sm text-on-surface-variant">{p.date}</td>
                          <td className="px-lg py-sm text-label-md font-bold text-on-tertiary-container">{fmtUSD(p.amount)}</td>
                          <td className="px-lg py-sm">
                            <span className="bg-on-tertiary-container/15 text-on-tertiary-container px-sm py-xs rounded-full text-label-sm">{p.status}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              <div className="bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20 overflow-hidden">
                <div className="flex items-center gap-sm px-lg py-md border-b border-outline-variant/20">
                  <span className="material-symbols-outlined text-secondary">campaign</span>
                  <h3 className="text-headline-sm text-primary">Recent Meta Billings</h3>
                  <a href="/finance/meta" className="ml-auto text-secondary text-label-sm hover:underline flex items-center gap-xs">
                    Xem tất cả <span className="material-symbols-outlined text-[14px]">chevron_right</span>
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
                        <tr key={b.id} className="border-b border-outline-variant/10 hover:bg-surface-container-low/50">
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

            {/* Projects */}
            <div className="bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20 overflow-hidden">
              <div className="flex items-center gap-sm px-lg py-md border-b border-outline-variant/20">
                <span className="material-symbols-outlined text-secondary">folder_open</span>
                <h3 className="text-headline-sm text-primary">Projects</h3>
                <a href="/projects" className="ml-auto text-secondary text-label-sm hover:underline flex items-center gap-xs">
                  Dashboard <span className="material-symbols-outlined text-[14px]">chevron_right</span>
                </a>
              </div>
              {data.projects.list.length === 0 ? (
                <div className="px-lg py-xl text-center text-on-surface-variant text-body-sm">
                  Chưa có project. <a href="/setup/projects" className="text-secondary hover:underline">Tạo project</a>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-lg p-lg">
                  {data.projects.list.map(p => (
                    <a key={p.id} href="/projects"
                      className="block bg-surface-container rounded-xl p-lg border border-outline-variant/20 hover:border-secondary/40 hover:shadow-card transition-all">
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
            <span className="material-symbols-outlined text-[48px] text-on-surface-variant/30">dashboard</span>
            <h3 className="text-headline-sm text-primary mb-sm mt-lg">Không tải được dữ liệu</h3>
            <p className="text-body-md text-on-surface-variant">Kiểm tra server và thử lại.</p>
          </div>
        )}
      </main>
    </div>
  )
}

function HeroCard({ label, value, negative }: { label: string; value: string; negative?: boolean }) {
  return (
    <div className="col-span-1 bg-primary rounded-xl p-lg shadow-card border border-outline-variant/20">
      <div className="flex items-center justify-between mb-sm">
        <span className="text-label-sm uppercase tracking-wider text-on-primary/60">{label}</span>
        <span className="material-symbols-outlined text-[18px] text-on-primary/40">trending_up</span>
      </div>
      <div className={`text-stats-lg font-bold ${negative ? 'text-error' : 'text-on-primary'}`}>{value}</div>
    </div>
  )
}

function StatCard({ label, value, icon, positive, negative, sub }: { label: string; value: string; icon: string; positive?: boolean; negative?: boolean; sub?: string }) {
  const valueColor = positive ? 'text-on-tertiary-container' : negative ? 'text-error' : 'text-primary'
  return (
    <div className="rounded-xl p-lg shadow-card border border-outline-variant/20 bg-surface-container-lowest">
      <div className="flex items-center justify-between mb-sm">
        <span className="text-label-sm uppercase tracking-wider text-on-surface-variant">{label}</span>
        <span className={`material-symbols-outlined text-[18px] text-secondary`}>{icon}</span>
      </div>
      <div className={`text-stats-lg font-bold ${valueColor}`}>{value}</div>
      {sub && <p className="text-label-sm text-on-surface-variant mt-xs">{sub}</p>}
    </div>
  )
}

function MiniCard({ label, value, color }: { label: string; value: string; color: 'positive' | 'negative' | 'warn' | 'neutral' }) {
  const colorMap = { positive: 'text-on-tertiary-container', negative: 'text-error', warn: 'text-amber-500', neutral: 'text-primary' }
  return (
    <div className="bg-surface-container-lowest rounded-xl p-md border border-outline-variant/20">
      <p className="text-label-sm text-on-surface-variant uppercase tracking-wider mb-xs">{label}</p>
      <p className={`text-headline-sm font-bold ${colorMap[color]}`}>{value}</p>
    </div>
  )
}

function OverviewChart({ data }: { data: ChartPoint[] }) {
  if (data.length === 0) return null

  const W = 600
  const H = 130
  const PAD = { top: 8, right: 8, bottom: 24, left: 8 }
  const chartW = W - PAD.left - PAD.right
  const chartH = H - PAD.top - PAD.bottom

  const maxRevenue = Math.max(...data.map(d => d.revenue), 1)
  const maxSpend = Math.max(...data.map(d => d.adSpend), 1)
  const maxVal = Math.max(maxRevenue, maxSpend, 1)

  const barW = Math.max(2, (chartW / data.length) * 0.45)
  const toX = (i: number) => PAD.left + i * (chartW / data.length) + (chartW / data.length) / 2
  const toH = (v: number) => (v / maxVal) * chartH

  const pointsArray = data.map((d, i) => `${toX(i)},${PAD.top + chartH - ((d.revenue - d.adSpend) / maxVal) * chartH}`)
  const pathD = `M ${pointsArray.join(' L ')} L ${toX(data.length - 1)},${PAD.top + chartH} L ${toX(0)},${PAD.top + chartH} Z`
  const profitPoints = pointsArray.join(' ')

  const labelEvery = Math.ceil(data.length / 6)
  const fmtDate = (s: string) => {
    const d = new Date(s + 'T00:00:00Z')
    return `${d.getUTCDate()}/${d.getUTCMonth() + 1}`
  }

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
        <defs>
          <linearGradient id="overviewGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#22c55e" stopOpacity="0.3" />
            <stop offset="100%" stopColor="#22c55e" stopOpacity="0" />
          </linearGradient>
        </defs>

        {data.map((d, i) => {
          const x = toX(i)
          const rH = toH(d.revenue)
          const sH = toH(d.adSpend)
          return (
            <g key={d.date}>
              <rect x={x - barW} y={PAD.top + chartH - rH} width={barW} height={rH} fill="#3b82f6" fillOpacity="0.35" rx="1" />
              <rect x={x} y={PAD.top + chartH - sH} width={barW} height={sH} fill="#ef4444" fillOpacity="0.5" rx="1" />
            </g>
          )
        })}

        <path d={pathD} fill="url(#overviewGrad)" />
        <polyline points={profitPoints} fill="none" stroke="#22c55e" strokeWidth="2" strokeLinejoin="round" />

        {data.map((d, i) => {
          if (i % labelEvery !== 0 && i !== data.length - 1) return null
          return (
            <text key={d.date} x={toX(i)} y={H - 4} textAnchor="middle" fontSize="8" fill="currentColor" fillOpacity="0.4" className="text-on-surface-variant">
              {fmtDate(d.date)}
            </text>
          )
        })}
      </svg>

      <div className="flex gap-lg mt-xs">
        <div className="flex items-center gap-xs">
          <div className="w-3 h-2 rounded-sm bg-blue-500" style={{ opacity: 0.5 }} />
          <span className="text-label-sm text-on-surface-variant">Revenue</span>
        </div>
        <div className="flex items-center gap-xs">
          <div className="w-3 h-2 rounded-sm bg-red-500" style={{ opacity: 0.6 }} />
          <span className="text-label-sm text-on-surface-variant">Ad Spend</span>
        </div>
        <div className="flex items-center gap-xs">
          <div className="w-4 h-0.5 bg-green-500" />
          <span className="text-label-sm text-on-surface-variant">Profit</span>
        </div>
      </div>
    </div>
  )
}
