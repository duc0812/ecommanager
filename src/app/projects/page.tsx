'use client'
import { useEffect, useState } from 'react'
import Sidebar from '@/components/Sidebar'
import { RoleGate } from '@/components/RoleGate'

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
  }
  totalPayout: number
  totalRevenue: number
  totalPaymentFees: number
  totalAdSpend: number
  totalMetaBilling: number
  totalFulfillmentCost: number
  costs: { fulfillment: number; appBilling: number; toolsBilling: number }
  totalOtherCosts: number
  actualCashflow: number
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
  const [costs, setCosts] = useState({ appBilling: '0', toolsBilling: '0' })

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
    params.set('appBilling', costs.appBilling || '0')
    params.set('toolsBilling', costs.toolsBilling || '0')
    fetch(`/api/projects/analytics?${params}`)
      .then(r => r.json())
      .then((data: Analytics) => {
        setAnalytics(data)
        setAnalyticsLoading(false)
      })
  }, [selectedProject, selectedStaff, selectedMonth, costs])

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

            <CostInputs costs={costs} setCosts={setCosts} />

            {analyticsLoading ? (
              <div className="flex items-center justify-center py-[80px]">
                <span className="material-symbols-outlined animate-spin text-[28px] text-secondary">sync</span>
              </div>
            ) : analytics ? (
              <div className="space-y-xl">
                <section>
                  <div className="flex items-center gap-sm mb-lg">
                    <span className="material-symbols-outlined text-secondary">account_balance_wallet</span>
                    <h3 className="text-headline-sm text-primary">Actual Cashflow</h3>
                    <span className="text-label-sm text-on-surface-variant">
                      {selectedStaff === 'all' ? 'project payout - paid billing - costs' : 'seller-period payout - paid billing - costs'}
                    </span>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-lg">
                    <StatCard label="Shopify Payout" icon="payments" value={fmtUSD(analytics.totalPayout)} hint={`${analytics.payoutCount} paid payouts`} />
                    <StatCard label="Meta Billing" icon="receipt_long" value={fmtUSD(analytics.totalMetaBilling)} hint="paid billing transactions" />
                    <StatCard label="Other Costs" icon="receipt_long" value={fmtUSD(analytics.totalOtherCosts)} hint="fulfillment + app + tools" />
                    <StatCard
                      label={selectedStaff === 'all' ? 'Net Cashflow' : 'Seller Profit'}
                      icon="trending_up"
                      value={fmtUSD(analytics.actualCashflow)}
                      hint={selectedStaff === 'all' ? 'cash in hand' : 'seller active period'}
                      negative={analytics.actualCashflow < 0}
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
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-lg">
                    <StatCard label="Revenue" icon="storefront" value={fmtUSD(analytics.totalRevenue)} hint="Shopify gross revenue" />
                    <StatCard label="Payment Fees" icon="credit_card" value={fmtUSD(analytics.totalPaymentFees)} hint="Shopify payment fees" />
                    <StatCard label="Variable Costs" icon="receipt_long" value={fmtUSD(analytics.totalOtherCosts)} hint="fulfillment + app + tools" />
                    <StatCard label="Gross Profit" icon="savings" value={fmtUSD(analytics.grossProfit)} hint={`${fmtPercent(analytics.grossMargin)} gross margin`} negative={analytics.grossProfit < 0} strong />
                  </div>
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
              </div>
            ) : null}
          </>
        )}
      </main>
    </div>
    </RoleGate>
  )
}

function CostInputs({ costs, setCosts }: { costs: { appBilling: string; toolsBilling: string }; setCosts: (costs: { appBilling: string; toolsBilling: string }) => void }) {
  const inputCls = 'bg-surface-container border border-outline-variant/30 rounded-lg px-md py-xs text-body-sm focus:ring-2 focus:ring-secondary outline-none w-32'
  return (
    <div className="bg-surface-container-lowest rounded-xl border border-outline-variant/20 p-lg mb-xl">
      <div className="flex items-center gap-sm mb-md">
        <span className="material-symbols-outlined text-secondary">tune</span>
        <h3 className="text-headline-sm text-primary">Cost Buckets</h3>
        <span className="text-label-sm text-on-surface-variant">fulfillment comes from Finance - Fulfillment; these remain manual until integrations are added</span>
      </div>
      <div className="flex flex-wrap gap-md">
        <label className="flex items-center gap-sm text-label-sm text-on-surface-variant">
          App billing
          <input className={inputCls} type="number" min="0" value={costs.appBilling} onChange={e => setCosts({ ...costs, appBilling: e.target.value })} />
        </label>
        <label className="flex items-center gap-sm text-label-sm text-on-surface-variant">
          Tools billing
          <input className={inputCls} type="number" min="0" value={costs.toolsBilling} onChange={e => setCosts({ ...costs, toolsBilling: e.target.value })} />
        </label>
      </div>
    </div>
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
