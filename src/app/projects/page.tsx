'use client'
import { useEffect, useState } from 'react'
import Sidebar from '@/components/Sidebar'
import { RoleGate } from '@/components/RoleGate'
import { calcGoalMetrics } from '@/lib/goal-tracker'

type Assignment = {
  id: string
  staffId: string
  startDate: string
  endDate: string | null
  staff: { id: string; name: string; role: string | null; monthlyCost: number }
}

type Project = {
  id: string
  name: string
  startDate: string
  description: string | null
  assignments: Assignment[]
}

type SpendAccount = {
  accountId: string
  accountName: string | null
  spend: number
  source: string
  error?: string
}

type DailyProfitPoint = {
  date: string
  orders: number
  ordersUnmapped: number
  revenue: number
  profit: number
  adSpend: number
}

type ProfitChartData = {
  dailyData: DailyProfitPoint[]
  summary: {
    totalOrders: number
    totalOrdersUnmapped: number
    totalRevenue: number
    totalProfit: number
    totalAdSpend: number
    netProfit: number
    avgMargin: number
    avgOrderProfit: number
  }
}

type AutoSyncStatus = {
  status: string
  lastResult: {
    startedAt: string
    finishedAt?: string
    orders?: { synced?: number; skipped?: number; error?: string }
    insights?: { synced?: number; accounts?: number; error?: string }
  } | null
}

type Analytics = {
  project: Project
  labelAudit: {
    project: { id: string; name: string; startDate: string }
    staff: { id: string; staffId: string; staffName: string; role: string | null; startDate: string; endDate: string | null; monthlyCost: number }[]
    period: { start: string; end: string | null }
    metaAccounts: { id: string; accountId: string; accountName: string | null }[]
  }
  dataDiagnostics: {
    period: { start: string; end: string }
    metaBilling: { source: string; firstDate: string | null; lastDate: string | null; transactionCount: number }
    actualAdSpend: { source: string; note: string }
    orderProfit?: { source: string; mappedOrderCount: number; unmappedOrderCount: number; estimateRule?: string }
  }
  totalPayout: number
  totalRevenue: number
  totalPaymentFees: number
  totalAdSpend: number
  totalMetaBilling: number
  totalFulfillmentCost: number
  totalOrderProfit: number
  totalOrderCogs: number
  cashflowCosts: number
  mappedOrderCount: number
  unmappedOrderCount: number
  costs: { fulfillment: number; appBilling: number; toolsBilling: number }
  totalOtherCosts: number
  actualCashflow: number
  shopifyBalance: number
  shopifyBalanceCurrency: string | null
  projectedCashflow: number
  grossProfit: number
  grossMargin: number
  adSpendRatio: number
  roas: number
  payoutCount: number
  avgRevenuePerPayout: number
  spendByAccount: SpendAccount[]
  dateRange: { start: string; end: string | null }
}

function fmt(dateStr: string) {
  return new Date(dateStr).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

function fmtUSD(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(n || 0)
}

function fmtPercent(n: number) {
  return `${(n || 0).toFixed(1)}%`
}

function fmtRatio(n: number) {
  return `${(n || 0).toFixed(2)}x`
}

function monthLabel(month: string) {
  if (!month) return 'All time'
  return new Date(`${month}-01T00:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
}

export default function ProjectDashboard() {
  const [projects, setProjects] = useState<Project[]>([])
  const [selectedProject, setSelectedProject] = useState<string | null>(null)
  const [selectedStaff, setSelectedStaff] = useState<string>('all')
  const [selectedMonth, setSelectedMonth] = useState<string>('')
  const [analytics, setAnalytics] = useState<Analytics | null>(null)
  const [loading, setLoading] = useState(true)
  const [analyticsLoading, setAnalyticsLoading] = useState(false)
  const [chartPeriod, setChartPeriod] = useState<string>('this-month')
  const [syncStatus, setSyncStatus] = useState<AutoSyncStatus | null>(null)
  const [syncing, setSyncing] = useState(false)

  useEffect(() => {
    fetch('/api/auto-sync').then(r => r.json()).then(setSyncStatus).catch(() => {})
  }, [])

  function handleManualSync() {
    setSyncing(true)
    fetch('/api/auto-sync', { method: 'POST' })
      .then(r => r.json())
      .then(() => fetch('/api/auto-sync').then(r => r.json()).then(setSyncStatus))
      .finally(() => setSyncing(false))
  }

  useEffect(() => {
    fetch('/api/projects')
      .then(r => r.json())
      .then((data: Project[]) => {
        const list = Array.isArray(data) ? data : []
        setProjects(list)
        if (list.length > 0) setSelectedProject(list[0].id)
        setLoading(false)
      })
  }, [])

  useEffect(() => {
    if (!selectedProject) return
    setAnalyticsLoading(true)
    const params = new URLSearchParams({ projectId: selectedProject })
    if (selectedStaff !== 'all') params.set('staffId', selectedStaff)
    if (selectedMonth) params.set('month', selectedMonth)
    fetch(`/api/projects/analytics?${params}`)
      .then(r => r.json())
      .then((data: Analytics) => {
        setAnalytics(data)
        setAnalyticsLoading(false)
      })
  }, [selectedProject, selectedStaff, selectedMonth])

  const currentProject = projects.find(p => p.id === selectedProject)

  return (
    <RoleGate>
    <div className="flex min-h-screen bg-surface">
      <Sidebar />
      <main className="ml-[280px] flex-1 p-xl">
        <header className="mb-xl">
          <h2 className="text-display-md font-bold text-primary">Project Management</h2>
          <p className="text-on-surface-variant text-body-md mt-xs">Actual cashflow, seller profit, and marketing efficiency by project period</p>
        </header>

        {loading ? (
          <div className="flex items-center justify-center py-[120px]">
            <span className="material-symbols-outlined animate-spin text-[32px] text-secondary">sync</span>
          </div>
        ) : projects.length === 0 ? (
          <div className="bg-surface-container-lowest rounded-xl border border-outline-variant/20 p-xl text-center">
            <span className="material-symbols-outlined text-[48px] text-on-surface-variant/30">folder_open</span>
            <p className="text-on-surface-variant mt-md">No projects yet. Create one in <a href="/setup/projects" className="text-secondary underline">Setup - Projects</a>.</p>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-xs mb-xl overflow-x-auto pb-xs">
              {projects.map(p => (
                <button
                  key={p.id}
                  onClick={() => { setSelectedProject(p.id); setSelectedStaff('all') }}
                  className={`flex-shrink-0 px-lg py-sm rounded-lg text-label-md font-semibold transition-all ${
                    selectedProject === p.id
                      ? 'bg-secondary text-on-secondary shadow-sm'
                      : 'bg-surface-container text-on-surface-variant hover:bg-surface-container-high'
                  }`}
                >
                  {p.name}
                </button>
              ))}
            </div>

            {currentProject && (
              <div className="flex items-center gap-md mb-lg flex-wrap">
                <div className="flex items-center gap-sm">
                  <span className="material-symbols-outlined text-[16px] text-on-surface-variant">filter_alt</span>
                  <span className="text-label-sm text-on-surface-variant">Staff period:</span>
                </div>
                <select
                  value={selectedStaff}
                  onChange={e => setSelectedStaff(e.target.value)}
                  className="bg-surface-container border border-outline-variant/30 rounded-lg px-md py-xs text-body-sm focus:ring-2 focus:ring-secondary outline-none"
                >
                  <option value="all">All staff</option>
                  {currentProject.assignments.map(a => (
                    <option key={a.staffId} value={a.staffId}>
                      {a.staff.name}{a.staff.role ? ` (${a.staff.role})` : ''}
                    </option>
                  ))}
                </select>
                <div className="flex items-center gap-sm">
                  <span className="text-label-sm text-on-surface-variant">Month:</span>
                  <input
                    type="month"
                    value={selectedMonth}
                    onChange={e => setSelectedMonth(e.target.value)}
                    className="bg-surface-container border border-outline-variant/30 rounded-lg px-md py-xs text-body-sm focus:ring-2 focus:ring-secondary outline-none"
                  />
                  {selectedMonth && (
                    <button
                      onClick={() => setSelectedMonth('')}
                      className="bg-surface-container text-on-surface-variant hover:bg-surface-container-high rounded-lg px-md py-xs text-label-sm"
                    >
                      All time
                    </button>
                  )}
                </div>
                {analytics && (
                  <span className="text-label-sm text-on-surface-variant ml-auto">
                    {selectedMonth ? `${monthLabel(selectedMonth)}: ` : ''}
                    {fmt(analytics.dateRange.start)} to {analytics.dateRange.end ? fmt(analytics.dateRange.end) : 'now'}
                  </span>
                )}
              </div>
            )}

            {analyticsLoading ? (
              <div className="flex items-center justify-center py-[80px]">
                <span className="material-symbols-outlined animate-spin text-[28px] text-secondary">sync</span>
              </div>
            ) : analytics ? (
              <div className="space-y-xl">
                {selectedProject && (
                  <section>
                    <RevenueGoalTracker projectId={selectedProject} />
                  </section>
                )}

                {selectedProject && (
                  <ProfitChart
                    projectId={selectedProject}
                    period={chartPeriod}
                    onPeriodChange={setChartPeriod}
                  />
                )}

                <section>
                  <div className="flex items-center gap-sm mb-lg">
                    <span className="material-symbols-outlined text-secondary">account_balance_wallet</span>
                    <h3 className="text-headline-sm text-primary">Actual Cashflow</h3>
                    <span className="text-label-sm text-on-surface-variant">
                      {selectedStaff === 'all' ? 'payout - paid billing - COGS - costs' : 'seller-period payout - paid billing - COGS - costs'}
                    </span>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-6 gap-lg">
                    <StatCard label="Shopify Payout" icon="payments" value={fmtUSD(analytics.totalPayout)} hint={`${analytics.payoutCount} paid payouts`} />
                    <StatCard label="Meta Billing" icon="receipt_long" value={fmtUSD(analytics.totalMetaBilling)} hint="paid billing transactions" />
                    <StatCard label="COGS" icon="inventory_2" value={fmtUSD(analytics.totalOrderCogs)} hint={analytics.unmappedOrderCount > 0 ? `${analytics.unmappedOrderCount} order(s) tạm tính` : 'mapped order costs'} />
                    <StatCard label="Other Costs" icon="receipt_long" value={fmtUSD(analytics.totalOtherCosts)} hint="manual app + tools" />
                    <StatCard
                      label={selectedStaff === 'all' ? 'Net Cashflow' : 'Seller Profit'}
                      icon="trending_up"
                      value={fmtUSD(analytics.actualCashflow)}
                      hint={selectedStaff === 'all' ? 'cash after billing and costs' : 'seller active period'}
                      negative={analytics.actualCashflow < 0}
                      strong
                    />
                    <StatCard
                      label="Projected Cashflow"
                      icon="account_balance"
                      value={fmtUSD(analytics.projectedCashflow)}
                      hint={`includes ${fmtUSD(analytics.shopifyBalance)} Shopify balance`}
                      negative={analytics.projectedCashflow < 0}
                      strong
                    />
                  </div>
                </section>

                <section>
                  <div className="flex items-center gap-sm mb-lg">
                    <span className="material-symbols-outlined text-secondary">request_quote</span>
                    <h3 className="text-headline-sm text-primary">Gross Profit</h3>
                    <span className="text-label-sm text-on-surface-variant">revenue - payment fees - variable costs - actual ad spend</span>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-6 gap-lg">
                    <StatCard label="Revenue" icon="storefront" value={fmtUSD(analytics.totalRevenue)} hint="Shopify gross revenue" />
                    <StatCard label="Payment Fees" icon="credit_card" value={fmtUSD(analytics.totalPaymentFees)} hint="Shopify payment fees" />
                    <StatCard
                      label="COGS"
                      icon="inventory_2"
                      value={fmtUSD(analytics.totalOrderCogs)}
                      hint={analytics.unmappedOrderCount > 0 ? `${analytics.unmappedOrderCount} order(s) tạm tính` : 'base cost + shipping'}
                    />
                    <StatCard label="Ad Spend" icon="campaign" value={fmtUSD(analytics.totalAdSpend)} hint="Meta Insights spend" negative={analytics.totalAdSpend > 0} />
                    <StatCard label="Other Costs" icon="receipt_long" value={fmtUSD(analytics.totalOtherCosts)} hint="manual app + tools" />
                    <StatCard label="Gross Profit" icon="savings" value={fmtUSD(analytics.grossProfit)} hint={`${fmtPercent(analytics.grossMargin)} gross margin`} negative={analytics.grossProfit < 0} strong />
                  </div>
                  {analytics.unmappedOrderCount > 0 && (
                    <p className="mt-sm text-label-sm text-amber-600">
                      {analytics.unmappedOrderCount} order(s) chưa map đủ đang dùng COGS tạm tính: 50% payout còn thiếu sau phần COGS đã biết.
                    </p>
                  )}
                </section>

                <section>
                  <div className="flex items-center gap-sm mb-lg">
                    <span className="material-symbols-outlined text-secondary">monitoring</span>
                    <h3 className="text-headline-sm text-primary">Marketing Efficiency</h3>
                    <span className="text-label-sm text-on-surface-variant">revenue efficiency against actual Meta spend</span>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-lg">
                    <StatCard label="Total Revenue" icon="storefront" value={fmtUSD(analytics.totalRevenue)} hint="Shopify gross revenue" />
                    <StatCard label="Actual Ad Spend" icon="campaign" value={fmtUSD(analytics.totalAdSpend)} hint="Meta Insights spend" />
                    <StatCard label="ROAS / MER" icon="analytics" value={fmtRatio(analytics.roas)} hint="revenue / ad spend" />
                    <StatCard label="Ad Spend %" icon="percent" value={fmtPercent(analytics.adSpendRatio)} hint="ad spend / revenue" />
                  </div>
                </section>

                <div className="grid grid-cols-1 xl:grid-cols-2 gap-lg">
                  <LabelAudit analytics={analytics} />
                  <DataDiagnostics analytics={analytics} />
                  <CostBreakdown analytics={analytics} />
                  <MetaAccountSpend accounts={analytics.spendByAccount} />
                </div>

                {selectedStaff === 'all' && currentProject && currentProject.assignments.length > 0 && (
                  <ProjectStaff assignments={currentProject.assignments} onSelect={setSelectedStaff} />
                )}

                <AutoSyncStatusBar status={syncStatus} syncing={syncing} onSync={handleManualSync} />
              </div>
            ) : null}
          </>
        )}
      </main>
    </div>
    </RoleGate>
  )
}

function StatCard({ label, icon, value, hint, negative = false, strong = false }: { label: string; icon: string; value: string; hint: string; negative?: boolean; strong?: boolean }) {
  return (
    <div className={`${strong ? 'bg-primary text-on-primary' : 'bg-surface-container-lowest'} rounded-xl border border-outline-variant/20 p-lg`}>
      <div className="flex items-center gap-sm mb-sm">
        <span className={`material-symbols-outlined text-[18px] ${strong ? 'text-on-primary/60' : 'text-secondary'}`}>{icon}</span>
        <span className={`text-label-sm uppercase tracking-wider ${strong ? 'text-on-primary/60' : 'text-on-surface-variant'}`}>{label}</span>
      </div>
      <p className={`text-stats-lg ${strong ? 'text-on-primary' : negative ? 'text-error' : 'text-primary'}`}>{value}</p>
      <p className={`text-label-sm mt-xs ${strong ? 'text-on-primary/50' : 'text-on-surface-variant'}`}>{hint}</p>
    </div>
  )
}

function CostBreakdown({ analytics }: { analytics: Analytics }) {
  const rows = [
    ['Meta billing paid', analytics.totalMetaBilling],
    ['Fulfillment cost', analytics.costs.fulfillment],
    ['App billing', analytics.costs.appBilling],
    ['Tools billing', analytics.costs.toolsBilling],
  ] as const

  return (
    <div className="bg-surface-container-lowest rounded-xl border border-outline-variant/20 overflow-hidden">
      <div className="flex items-center gap-sm px-lg py-md border-b border-outline-variant/20">
        <span className="material-symbols-outlined text-secondary">receipt_long</span>
        <h3 className="text-headline-sm text-primary">Cashflow Cost Stack</h3>
      </div>
      <div className="divide-y divide-outline-variant/10">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-center justify-between px-lg py-md">
            <span className="text-body-sm text-on-surface-variant">{label}</span>
            <span className="text-label-md text-primary">{fmtUSD(value)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function LabelAudit({ analytics }: { analytics: Analytics }) {
  return (
    <div className="bg-surface-container-lowest rounded-xl border border-outline-variant/20 overflow-hidden">
      <div className="flex items-center gap-sm px-lg py-md border-b border-outline-variant/20">
        <span className="material-symbols-outlined text-secondary">label</span>
        <h3 className="text-headline-sm text-primary">Label Audit</h3>
      </div>
      <div className="p-lg space-y-md">
        <div>
          <p className="text-label-sm text-on-surface-variant uppercase tracking-wider mb-xs">Project label</p>
          <div className="flex flex-wrap gap-xs">
            <span className="bg-secondary/10 text-secondary px-sm py-xs rounded-full text-label-sm">
              {analytics.labelAudit.project.name}
            </span>
            <span className="bg-surface-container text-on-surface-variant px-sm py-xs rounded-full text-label-sm">
              from {fmt(analytics.labelAudit.project.startDate)}
            </span>
          </div>
        </div>

        <div>
          <p className="text-label-sm text-on-surface-variant uppercase tracking-wider mb-xs">Seller labels active in period</p>
          {analytics.labelAudit.staff.length === 0 ? (
            <p className="text-body-sm text-on-surface-variant">No seller assignment active for this period.</p>
          ) : (
            <div className="flex flex-wrap gap-xs">
              {analytics.labelAudit.staff.map(staff => (
                <span key={staff.id} className="bg-surface-container text-on-surface-variant px-sm py-xs rounded-full text-label-sm">
                  {staff.staffName}{staff.role ? ` - ${staff.role}` : ''} ({fmt(staff.startDate)}{staff.endDate ? ` to ${fmt(staff.endDate)}` : '+'})
                </span>
              ))}
            </div>
          )}
        </div>

        <div>
          <p className="text-label-sm text-on-surface-variant uppercase tracking-wider mb-xs">Meta accounts</p>
          {analytics.labelAudit.metaAccounts.length === 0 ? (
            <p className="text-body-sm text-on-surface-variant">No Meta ad account assigned.</p>
          ) : (
            <div className="flex flex-wrap gap-xs">
              {analytics.labelAudit.metaAccounts.map(account => (
                <span key={account.id} className="bg-surface-container text-on-surface-variant px-sm py-xs rounded-full text-label-sm">
                  {account.accountName || account.accountId}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function DataDiagnostics({ analytics }: { analytics: Analytics }) {
  return (
    <div className="bg-surface-container-lowest rounded-xl border border-outline-variant/20 overflow-hidden">
      <div className="flex items-center gap-sm px-lg py-md border-b border-outline-variant/20">
        <span className="material-symbols-outlined text-secondary">fact_check</span>
        <h3 className="text-headline-sm text-primary">Data Check</h3>
      </div>
      <div className="p-lg space-y-md">
        <div className="flex items-center justify-between gap-md">
          <span className="text-body-sm text-on-surface-variant">Report period</span>
          <span className="text-label-md text-primary">{fmt(analytics.dataDiagnostics.period.start)} to {fmt(analytics.dataDiagnostics.period.end)}</span>
        </div>
        <div className="flex items-center justify-between gap-md">
          <span className="text-body-sm text-on-surface-variant">Billing source</span>
          <span className="text-label-md text-primary">{analytics.dataDiagnostics.metaBilling.transactionCount} paid charges</span>
        </div>
        <div className="flex items-center justify-between gap-md">
          <span className="text-body-sm text-on-surface-variant">Billing coverage</span>
          <span className="text-label-md text-primary">
            {analytics.dataDiagnostics.metaBilling.firstDate ? fmt(analytics.dataDiagnostics.metaBilling.firstDate) : '-'}
            {' to '}
            {analytics.dataDiagnostics.metaBilling.lastDate ? fmt(analytics.dataDiagnostics.metaBilling.lastDate) : '-'}
          </span>
        </div>
        <p className="text-label-sm text-on-surface-variant">{analytics.dataDiagnostics.actualAdSpend.note}</p>
        {analytics.dataDiagnostics.orderProfit && (
          <p className="text-label-sm text-on-surface-variant">
            Gross Profit uses {analytics.dataDiagnostics.orderProfit.mappedOrderCount} mapped order(s); {analytics.dataDiagnostics.orderProfit.unmappedOrderCount} estimated.
          </p>
        )}
      </div>
    </div>
  )
}

function MetaAccountSpend({ accounts }: { accounts: SpendAccount[] }) {
  return (
    <div className="bg-surface-container-lowest rounded-xl border border-outline-variant/20 overflow-hidden">
      <div className="flex items-center gap-sm px-lg py-md border-b border-outline-variant/20">
        <span className="material-symbols-outlined text-secondary">campaign</span>
        <h3 className="text-headline-sm text-primary">Meta Spend Sources</h3>
      </div>
      {accounts.length === 0 ? (
        <div className="px-lg py-xl text-center text-on-surface-variant text-body-sm">No Meta ad account assigned to this project.</div>
      ) : (
        <div className="divide-y divide-outline-variant/10">
          {accounts.map(account => (
            <div key={account.accountId} className="flex items-center justify-between px-lg py-md">
              <div>
                <p className="text-label-md text-primary">{account.accountName || account.accountId}</p>
                <p className="text-label-sm text-on-surface-variant">{account.error ? account.error : account.source}</p>
              </div>
              <span className="text-label-md text-primary">{fmtUSD(account.spend)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ProjectStaff({ assignments, onSelect }: { assignments: Assignment[]; onSelect: (staffId: string) => void }) {
  return (
    <div className="bg-surface-container-lowest rounded-xl border border-outline-variant/20 overflow-hidden">
      <div className="flex items-center gap-sm px-lg py-md border-b border-outline-variant/20">
        <span className="material-symbols-outlined text-secondary">group</span>
        <h3 className="text-headline-sm text-primary">Project Staff</h3>
      </div>
      <div className="divide-y divide-outline-variant/10">
        {assignments.map(a => (
          <div key={a.staffId} className="flex items-center justify-between px-lg py-md hover:bg-surface-container-low/40 transition-colors">
            <div>
              <p className="text-label-md text-primary">{a.staff.name}</p>
              <p className="text-label-sm text-on-surface-variant">
                {a.staff.role && `${a.staff.role} - `}From {fmt(a.startDate)}
                {a.endDate && ` to ${fmt(a.endDate)}`}
              </p>
            </div>
            <button onClick={() => onSelect(a.staffId)} className="text-secondary text-label-sm hover:underline">View staff period</button>
          </div>
        ))}
      </div>
    </div>
  )
}


function ProfitChart({ projectId, period, onPeriodChange }: { projectId: string; period: string; onPeriodChange: (p: string) => void }) {
  const [data, setData] = useState<ProfitChartData | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    setLoading(true)
    fetch(`/api/projects/profit-chart?projectId=${projectId}&period=${period}`)
      .then(r => r.json())
      .then(setData)
      .finally(() => setLoading(false))
  }, [projectId, period])

  const periods = [
    { key: 'today', label: 'Hôm nay' },
    { key: 'this-week', label: 'Tuần này' },
    { key: 'this-month', label: 'Tháng này' },
  ]

  return (
    <div className="bg-surface-container-lowest rounded-xl border border-outline-variant/20 overflow-hidden">
      <div className="flex items-center justify-between px-lg py-md border-b border-outline-variant/20 flex-wrap gap-sm">
        <div className="flex items-center gap-sm">
          <span className="material-symbols-outlined text-secondary">show_chart</span>
          <h3 className="text-headline-sm text-primary">Profit Chart</h3>
          <span className="text-label-sm text-on-surface-variant">profit từng đơn hàng</span>
        </div>
        <div className="flex gap-xs">
          {periods.map(p => (
            <button
              key={p.key}
              onClick={() => onPeriodChange(p.key)}
              className={`px-md py-xs rounded-lg text-label-sm font-semibold transition-all ${
                period === p.key
                  ? 'bg-secondary text-on-secondary'
                  : 'bg-surface-container text-on-surface-variant hover:bg-surface-container-high'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-xl">
          <span className="material-symbols-outlined animate-spin text-secondary">sync</span>
        </div>
      )}

      {data && !loading && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-md p-lg border-b border-outline-variant/10">
            <div className="bg-surface-container rounded-xl p-md">
              <p className="text-label-sm text-on-surface-variant uppercase tracking-wider mb-xs">Revenue</p>
              <p className="text-stats-lg font-bold text-primary">
                {new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(data.summary.totalRevenue)}
              </p>
            </div>
            <div className="bg-surface-container rounded-xl p-md">
              <p className="text-label-sm text-on-surface-variant uppercase tracking-wider mb-xs">Orders</p>
              <p className="text-stats-lg font-bold text-primary">{data.summary.totalOrders}</p>
              {data.summary.totalOrdersUnmapped > 0 && (
                <p className="text-label-sm text-amber-500">{data.summary.totalOrdersUnmapped} tạm tính</p>
              )}
            </div>
            <div className="bg-surface-container rounded-xl p-md">
              <p className="text-label-sm text-on-surface-variant uppercase tracking-wider mb-xs">Avg Margin</p>
              <p className="text-stats-lg font-bold text-secondary">{data.summary.avgMargin.toFixed(1)}%</p>
            </div>
            <div className="bg-surface-container rounded-xl p-md">
              <p className="text-label-sm text-on-surface-variant uppercase tracking-wider mb-xs">Ad Spend</p>
              <p className="text-stats-lg font-bold text-error">
                {new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(data.summary.totalAdSpend)}
              </p>
            </div>
            <div className="bg-surface-container rounded-xl p-md">
              <p className="text-label-sm text-on-surface-variant uppercase tracking-wider mb-xs">Net Profit</p>
              <p className={`text-stats-lg font-bold ${data.summary.netProfit >= 0 ? 'text-on-tertiary-container' : 'text-error'}`}>
                {new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(data.summary.netProfit)}
              </p>
            </div>
          </div>

          <ProfitChartSVG data={data.dailyData} />
        </>
      )}

      {data && data.dailyData.length === 0 && !loading && (
        <div className="px-lg py-xl text-center text-on-surface-variant text-body-sm">
          Không có dữ liệu cho khoảng thời gian này.
        </div>
      )}
    </div>
  )
}

function ProfitChartSVG({ data }: { data: DailyProfitPoint[] }) {
  if (data.length === 0) return null

  const W = 600
  const H = 150
  const PAD = { top: 12, right: 12, bottom: 28, left: 8 }
  const chartW = W - PAD.left - PAD.right
  const chartH = H - PAD.top - PAD.bottom

  const maxOrders = Math.max(...data.map(d => d.orders), 1)
  const maxProfit = Math.max(...data.map(d => d.profit), 1)
  const minProfit = Math.min(...data.map(d => d.profit), 0)
  const profitRange = maxProfit - minProfit || 1

  const barW = Math.max(2, (chartW / data.length) * 0.6)
  const step = chartW / Math.max(data.length - 1, 1)

  const toX = (i: number) => PAD.left + i * step
  const toYProfit = (v: number) => PAD.top + chartH - ((v - minProfit) / profitRange) * chartH

  const profitPoints = data.map((d, i) => `${toX(i)},${toYProfit(d.profit)}`).join(' ')

  const fmtDate = (s: string) => {
    const d = new Date(s + 'T00:00:00Z')
    return `${d.getUTCDate()}/${d.getUTCMonth() + 1}`
  }

  const labelEvery = Math.ceil(data.length / 6)

  return (
    <div className="px-lg pb-lg">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ overflow: 'visible' }}>
        <defs>
          <linearGradient id="profitGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#22c55e" stopOpacity="0.25" />
            <stop offset="100%" stopColor="#22c55e" stopOpacity="0" />
          </linearGradient>
        </defs>

        {[0.25, 0.5, 0.75, 1].map(f => (
          <line key={f}
            x1={PAD.left} y1={PAD.top + chartH * (1 - f)}
            x2={PAD.left + chartW} y2={PAD.top + chartH * (1 - f)}
            stroke="currentColor" strokeOpacity="0.06" strokeWidth="1"
            className="text-on-surface-variant"
          />
        ))}

        {data.map((d, i) => {
          const x = toX(i)
          const barH = (d.orders / maxOrders) * chartH
          return (
            <rect key={d.date}
              x={x - barW / 2}
              y={PAD.top + chartH - barH}
              width={barW}
              height={barH}
              fill="#6366f1"
              fillOpacity="0.35"
              rx="1"
            />
          )
        })}

        <path
          d={`M${data.map((d, i) => `${toX(i)},${toYProfit(d.profit)}`).join(' L')} L${toX(data.length - 1)},${PAD.top + chartH} L${toX(0)},${PAD.top + chartH} Z`}
          fill="url(#profitGrad)"
        />
        <polyline
          points={profitPoints}
          fill="none"
          stroke="#22c55e"
          strokeWidth="2"
          strokeLinejoin="round"
        />

        {data.map((d, i) => {
          if (i !== data.length - 1 && i % labelEvery !== 0) return null
          return (
            <text key={d.date}
              x={toX(i)}
              y={H - 4}
              textAnchor="middle"
              fontSize="9"
              fill="currentColor"
              fillOpacity="0.4"
              className="text-on-surface-variant"
            >
              {fmtDate(d.date)}
            </text>
          )
        })}

        <circle cx={toX(data.length - 1)} cy={toYProfit(data[data.length - 1].profit)} r="4"
          fill="#22c55e" stroke="currentColor" strokeWidth="2" className="text-surface-container-lowest" />
      </svg>

      <div className="flex gap-lg mt-xs">
        <div className="flex items-center gap-xs">
          <div className="w-3 h-2 rounded-sm" style={{ background: '#6366f1', opacity: 0.5 }} />
          <span className="text-label-sm text-on-surface-variant">Orders/ngày</span>
        </div>
        <div className="flex items-center gap-xs">
          <div className="w-4 h-0.5 bg-green-500" />
          <span className="text-label-sm text-on-surface-variant">Profit ($)</span>
        </div>
      </div>
    </div>
  )
}

function RevenueGoalTracker({ projectId }: { projectId: string }) {
  const [monthlyTarget, setMonthlyTarget] = useState<number>(() => {
    if (typeof window === 'undefined') return 30000
    return Number(localStorage.getItem('goal_monthly') || '30000')
  })
  const [dailyTarget, setDailyTarget] = useState<number>(() => {
    if (typeof window === 'undefined') return 1000
    return Number(localStorage.getItem('goal_daily') || '1000')
  })
  const [data, setData] = useState<ProfitChartData | null>(null)
  const [monthlyDraft, setMonthlyDraft] = useState(String(monthlyTarget))
  const [dailyDraft, setDailyDraft] = useState(String(dailyTarget))
  const [fetchError, setFetchError] = useState(false)

  useEffect(() => {
    setData(null)
    setFetchError(false)
    fetch(`/api/projects/profit-chart?projectId=${projectId}&period=this-month`)
      .then(r => r.json())
      .then(setData)
      .catch(() => setFetchError(true))
  }, [projectId])

  function handleMonthlyTarget(val: string) {
    const n = Number(val)
    if (!Number.isFinite(n) || n <= 0) return
    setMonthlyTarget(n)
    localStorage.setItem('goal_monthly', String(n))
  }

  function handleDailyTarget(val: string) {
    const n = Number(val)
    if (!Number.isFinite(n) || n <= 0) return
    setDailyTarget(n)
    localStorage.setItem('goal_daily', String(n))
  }

  const now = new Date()
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
  const totalRevenue = data?.summary.totalRevenue ?? 0
  const daysElapsed = data?.dailyData.length ?? 0

  const metrics = calcGoalMetrics({ totalRevenue, daysElapsed, daysInMonth, monthlyTarget, dailyTarget })
  const { avgDaily, daysRemaining, projected, shortfall, neededPerDay, paceOk, monthPct } = metrics

  return (
    <div className="space-y-lg">
      <div className="flex items-center gap-sm mb-lg flex-wrap">
        <span className="material-symbols-outlined text-secondary">track_changes</span>
        <h3 className="text-headline-sm text-primary">Revenue Goals</h3>
        <div className="flex items-center gap-md ml-auto flex-wrap">
          <label className="flex items-center gap-xs text-label-sm text-on-surface-variant">
            Tháng $
            <input
              type="number"
              value={monthlyDraft}
              onChange={e => setMonthlyDraft(e.target.value)}
              onBlur={e => handleMonthlyTarget(e.target.value)}
              className="w-24 bg-surface-container border border-outline-variant/30 rounded-lg px-sm py-xs text-body-sm focus:ring-2 focus:ring-secondary outline-none"
            />
          </label>
          <label className="flex items-center gap-xs text-label-sm text-on-surface-variant">
            Ngày $
            <input
              type="number"
              value={dailyDraft}
              onChange={e => setDailyDraft(e.target.value)}
              onBlur={e => handleDailyTarget(e.target.value)}
              className="w-20 bg-surface-container border border-outline-variant/30 rounded-lg px-sm py-xs text-body-sm focus:ring-2 focus:ring-secondary outline-none"
            />
          </label>
        </div>
      </div>

      {fetchError ? (
        <p className="text-label-sm text-error py-md">Không tải được dữ liệu doanh thu.</p>
      ) : !data ? (
        <div className="flex items-center justify-center py-xl">
          <span className="material-symbols-outlined animate-spin text-secondary text-[24px]">sync</span>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-lg">
          <div className="bg-surface-container-lowest rounded-xl border border-outline-variant/20 p-lg">
            <div className="flex items-center gap-sm mb-sm">
              <span className="material-symbols-outlined text-[18px] text-secondary">calendar_month</span>
              <span className="text-label-sm uppercase tracking-wider text-on-surface-variant">Tháng này</span>
            </div>
            <p className="text-stats-lg text-primary">{fmtUSD(totalRevenue)}</p>
            <p className="text-label-sm text-on-surface-variant mt-xs">{monthPct.toFixed(1)}% · {daysElapsed} ngày đã qua</p>
            <div className="mt-md h-1 rounded-full bg-secondary/20">
              <div className="h-1 rounded-full bg-secondary transition-all duration-500" style={{ width: `${monthPct}%` }} />
            </div>
            <p className="text-label-sm text-on-surface-variant mt-xs">mục tiêu {fmtUSD(monthlyTarget)}</p>
          </div>

          <div className="bg-surface-container-lowest rounded-xl border border-outline-variant/20 p-lg">
            <div className="flex items-center gap-sm mb-sm">
              <span className="material-symbols-outlined text-[18px] text-secondary">speed</span>
              <span className="text-label-sm uppercase tracking-wider text-on-surface-variant">Pace hiện tại</span>
            </div>
            <p className={`text-stats-lg ${paceOk ? 'text-on-tertiary-container' : 'text-error'}`}>
              {fmtUSD(avgDaily)}<span className="text-body-md font-normal">/ngày</span>
            </p>
            <p className={`text-label-sm mt-xs ${paceOk ? 'text-on-tertiary-container' : 'text-error'}`}>
              {paceOk ? '▲ Đang vượt target' : '▼ Dưới target'} {fmtUSD(dailyTarget)}/ngày
            </p>
          </div>

          <div className="bg-surface-container-lowest rounded-xl border border-outline-variant/20 p-lg">
            <div className="flex items-center gap-sm mb-sm">
              <span className="material-symbols-outlined text-[18px] text-secondary">trending_up</span>
              <span className="text-label-sm uppercase tracking-wider text-on-surface-variant">Dự báo cuối tháng</span>
            </div>
            <p className={`text-stats-lg ${projected >= monthlyTarget ? 'text-on-tertiary-container' : 'text-primary'}`}>
              {fmtUSD(projected)}
            </p>
            <p className="text-label-sm text-on-surface-variant mt-xs">Dựa trên pace hiện tại</p>
          </div>

          <div className="bg-surface-container-lowest rounded-xl border border-outline-variant/20 p-lg">
            <div className="flex items-center gap-sm mb-sm">
              <span className="material-symbols-outlined text-[18px] text-secondary">flag</span>
              <span className="text-label-sm uppercase tracking-wider text-on-surface-variant">Còn thiếu</span>
            </div>
            {shortfall <= 0 ? (
              <p className="text-stats-lg text-on-tertiary-container">Đạt target!</p>
            ) : (
              <>
                <p className="text-stats-lg text-primary">{fmtUSD(shortfall)}</p>
                <p className="text-label-sm text-on-surface-variant mt-xs">
                  Cần {fmtUSD(neededPerDay)}/ngày · {daysRemaining} ngày còn lại
                </p>
                <div className="mt-md h-1 rounded-full bg-secondary/20">
                  <div className="h-1 rounded-full bg-secondary transition-all duration-500" style={{ width: `${monthPct}%` }} />
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function AutoSyncStatusBar({ status, syncing, onSync }: { status: AutoSyncStatus | null; syncing: boolean; onSync: () => void }) {
  const lastOrders = status?.lastResult?.orders
  const lastInsights = status?.lastResult?.insights
  const lastTime = status?.lastResult?.finishedAt
    ? new Date(status.lastResult.finishedAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })
    : null

  return (
    <div className="bg-surface-container-lowest rounded-xl border border-outline-variant/20 p-md flex items-center justify-between gap-md flex-wrap">
      <div className="flex items-center gap-sm">
        <div className="w-2 h-2 rounded-full bg-on-tertiary-container" style={{ boxShadow: '0 0 6px #4ade80' }} />
        <div>
          <p className="text-label-md text-primary">Auto-sync</p>
          <p className="text-label-sm text-on-surface-variant">
            {lastTime ? `Lần cuối: ${lastTime}` : 'Chưa sync'}
            {lastOrders && !lastOrders.error ? ` · Orders: ${lastOrders.synced ?? 0}` : ''}
            {lastInsights && !lastInsights.error ? ` · Insights: ${lastInsights.synced ?? 0} ngày` : ''}
          </p>
        </div>
      </div>
      <button
        onClick={onSync}
        disabled={syncing}
        className="bg-surface-container text-secondary hover:bg-surface-container-high rounded-lg px-md py-xs text-label-sm font-semibold flex items-center gap-xs disabled:opacity-50"
      >
        <span className={`material-symbols-outlined text-[14px] ${syncing ? 'animate-spin' : ''}`}>sync</span>
        {syncing ? 'Đang sync...' : 'Sync ngay'}
      </button>
    </div>
  )
}


