'use client'
import { FormEvent, useCallback, useEffect, useState } from 'react'
import Sidebar from '@/components/Sidebar'
import { RoleGate } from '@/components/RoleGate'

type Project = { id: string; name: string }
type Staff = { id: string; name: string; role: string | null }
type OtherBill = {
  id: string
  vendorName: string
  invoiceNumber: string | null
  billDate: string
  dueDate: string | null
  serviceStartDate: string | null
  serviceEndDate: string | null
  category: string
  expenseAccount: string
  description: string | null
  currency: string
  subtotalAmount: number
  taxAmount: number
  totalAmount: number
  paymentStatus: string
  paymentDate: string | null
  paymentMethod: string | null
  referenceNumber: string | null
  accountingBasis: string
  recognitionDate: string
  documentUrl: string | null
  documentName: string | null
  project: Project | null
  staff: Staff | null
}

type Data = {
  bills: OtherBill[]
  projects: Project[]
  staff: Staff[]
  categories: string[]
  paymentStatuses: string[]
  stats: {
    total: number
    paid: number
    unpaid: number
    count: number
    byCategory: { category: string; total: number; count: number }[]
  }
}

const CATEGORY_LABELS: Record<string, string> = {
  APP_BILLING: 'App billing',
  TOOLS_BILLING: 'Tools billing',
  SOFTWARE: 'Software',
  AGENCY: 'Agency',
  CONTRACTOR: 'Contractor',
  PAYMENT_PROCESSING: 'Payment processing',
  OFFICE: 'Office',
  TAX: 'Tax',
  OTHER: 'Other',
}

const EXPENSE_ACCOUNTS = [
  'Advertising support',
  'Software and subscriptions',
  'Professional services',
  'Contract labor',
  'Payment processing fees',
  'Office and admin',
  'Taxes and licenses',
  'Other operating expense',
]

function today() {
  return new Date().toISOString().split('T')[0]
}

function fmtUSD(n: number, currency = 'USD') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: 2 }).format(n || 0)
}

function fmt(dateStr: string | null) {
  if (!dateStr) return '-'
  return new Date(`${dateStr}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function statusClass(status: string) {
  if (status === 'PAID') return 'bg-on-tertiary-container/15 text-on-tertiary-container'
  if (status === 'VOID') return 'bg-surface-container text-on-surface-variant'
  if (status === 'PARTIAL') return 'bg-secondary/10 text-secondary'
  return 'bg-error/10 text-error'
}

function categoryLabel(category: string) {
  return CATEGORY_LABELS[category] ?? category
}

export default function OtherBillsPage() {
  const [data, setData] = useState<Data | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [filters, setFilters] = useState({ month: '', projectId: 'all', category: 'all', status: 'all' })

  const load = useCallback(async () => {
    setLoading(true)
    const params = new URLSearchParams()
    if (filters.month) params.set('month', filters.month)
    if (filters.projectId !== 'all') params.set('projectId', filters.projectId)
    if (filters.category !== 'all') params.set('category', filters.category)
    if (filters.status !== 'all') params.set('status', filters.status)
    const res = await fetch(`/api/finance/other-bills?${params}`)
    const json = await res.json()
    setData(json)
    setLoading(false)
  }, [filters])

  useEffect(() => { load() }, [load])

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setSaving(true)
    setMessage(null)
    const form = new FormData(e.currentTarget)
    const res = await fetch('/api/finance/other-bills', { method: 'POST', body: form })
    const json = await res.json()
    if (!res.ok) {
      setMessage(json.error || 'Could not save bill')
      setSaving(false)
      return
    }
    e.currentTarget.reset()
    setMessage('Bill saved.')
    await load()
    setSaving(false)
  }

  async function deleteBill(id: string) {
    await fetch(`/api/finance/other-bills/${id}`, { method: 'DELETE' })
    await load()
  }

  const projects = data?.projects ?? []
  const staff = data?.staff ?? []
  const categories = data?.categories ?? Object.keys(CATEGORY_LABELS)
  const statuses = data?.paymentStatuses ?? ['UNPAID', 'PARTIAL', 'PAID', 'VOID']

  return (
    <RoleGate>
    <div className="flex min-h-screen bg-surface">
      <Sidebar />
      <main className="ml-[280px] flex-1 p-xl">
        <header className="mb-xl">
          <h2 className="text-display-md font-bold text-primary">Other Bills</h2>
          <p className="text-on-surface-variant text-body-md mt-xs">Manual invoice capture for costs that cannot be synced by API</p>
        </header>

        <div className="grid grid-cols-1 xl:grid-cols-[420px_1fr] gap-xl items-start">
          <form onSubmit={submit} className="bg-surface-container-lowest rounded-xl border border-outline-variant/20 overflow-hidden">
            <div className="px-lg py-md border-b border-outline-variant/20 flex items-center gap-sm">
              <span className="material-symbols-outlined text-secondary">upload_file</span>
              <h3 className="text-headline-sm text-primary">Add Bill</h3>
            </div>
            <div className="p-lg space-y-lg">
              <FieldGroup title="Source Document">
                <TextInput name="vendorName" label="Vendor / supplier" required />
                <TextInput name="invoiceNumber" label="Invoice number" />
                <div className="grid grid-cols-2 gap-md">
                  <TextInput name="billDate" label="Invoice date" type="date" required defaultValue={today()} />
                  <TextInput name="dueDate" label="Due date" type="date" />
                </div>
                <input name="document" type="file" accept="application/pdf,image/*,.csv,.xlsx,.xls" className="block w-full text-body-sm text-on-surface-variant file:mr-md file:rounded-lg file:border-0 file:bg-secondary file:px-md file:py-xs file:text-on-secondary file:text-label-sm" />
              </FieldGroup>

              <FieldGroup title="Expense Recognition">
                <div className="grid grid-cols-2 gap-md">
                  <SelectInput name="category" label="Category" options={categories.map(c => [c, categoryLabel(c)])} required />
                  <SelectInput name="expenseAccount" label="Expense account" options={EXPENSE_ACCOUNTS.map(a => [a, a])} required />
                </div>
                <div className="grid grid-cols-2 gap-md">
                  <TextInput name="recognitionDate" label="Recognition date" type="date" required defaultValue={today()} />
                  <SelectInput name="accountingBasis" label="Basis" options={[['ACCRUAL', 'Accrual'], ['CASH', 'Cash']]} required />
                </div>
                <div className="grid grid-cols-2 gap-md">
                  <TextInput name="serviceStartDate" label="Service start" type="date" />
                  <TextInput name="serviceEndDate" label="Service end" type="date" />
                </div>
              </FieldGroup>

              <FieldGroup title="Amounts">
                <div className="grid grid-cols-3 gap-md">
                  <TextInput name="currency" label="Currency" defaultValue="USD" required />
                  <TextInput name="subtotalAmount" label="Subtotal" type="number" step="0.01" required />
                  <TextInput name="taxAmount" label="Tax" type="number" step="0.01" defaultValue="0" />
                </div>
                <TextInput name="totalAmount" label="Total amount" type="number" step="0.01" />
              </FieldGroup>

              <FieldGroup title="Payment & Allocation">
                <div className="grid grid-cols-2 gap-md">
                  <SelectInput name="paymentStatus" label="Payment status" options={statuses.map(s => [s, s])} required />
                  <TextInput name="paymentDate" label="Payment date" type="date" />
                </div>
                <div className="grid grid-cols-2 gap-md">
                  <TextInput name="paymentMethod" label="Payment method" />
                  <TextInput name="referenceNumber" label="Payment reference" />
                </div>
                <div className="grid grid-cols-2 gap-md">
                  <SelectInput name="projectId" label="Project label" options={[['', '-'], ...projects.map(p => [p.id, p.name])]} />
                  <SelectInput name="staffId" label="Seller label" options={[['', '-'], ...staff.map(s => [s.id, `${s.name}${s.role ? ` - ${s.role}` : ''}`])]} />
                </div>
                <TextArea name="description" label="Description" />
                <TextArea name="allocationNote" label="Allocation note" />
              </FieldGroup>

              {message && <p className={`text-body-sm ${message.includes('required') || message.includes('Valid') ? 'text-error' : 'text-on-tertiary-container'}`}>{message}</p>}
              <button disabled={saving} className="w-full bg-secondary text-on-secondary rounded-lg py-md text-label-md font-semibold disabled:opacity-50">
                {saving ? 'Saving...' : 'Save Bill'}
              </button>
            </div>
          </form>

          <section className="space-y-lg">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-lg">
              <StatCard label="Total bills" value={fmtUSD(data?.stats.total ?? 0)} hint={`${data?.stats.count ?? 0} invoices`} icon="receipt_long" />
              <StatCard label="Paid" value={fmtUSD(data?.stats.paid ?? 0)} hint="cash paid" icon="check_circle" />
              <StatCard label="Open payable" value={fmtUSD(data?.stats.unpaid ?? 0)} hint="unpaid + partial" icon="schedule" />
              <StatCard label="Categories" value={String(data?.stats.byCategory.length ?? 0)} hint="active cost buckets" icon="category" />
            </div>

            <div className="bg-surface-container-lowest rounded-xl border border-outline-variant/20 p-lg">
              <div className="flex items-center gap-md flex-wrap">
                <span className="material-symbols-outlined text-[18px] text-on-surface-variant">filter_alt</span>
                <input type="month" value={filters.month} onChange={e => setFilters({ ...filters, month: e.target.value })} className="bg-surface-container border border-outline-variant/30 rounded-lg px-md py-xs text-body-sm outline-none" />
                <select value={filters.projectId} onChange={e => setFilters({ ...filters, projectId: e.target.value })} className="bg-surface-container border border-outline-variant/30 rounded-lg px-md py-xs text-body-sm outline-none">
                  <option value="all">All projects</option>
                  {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <select value={filters.category} onChange={e => setFilters({ ...filters, category: e.target.value })} className="bg-surface-container border border-outline-variant/30 rounded-lg px-md py-xs text-body-sm outline-none">
                  <option value="all">All categories</option>
                  {categories.map(c => <option key={c} value={c}>{categoryLabel(c)}</option>)}
                </select>
                <select value={filters.status} onChange={e => setFilters({ ...filters, status: e.target.value })} className="bg-surface-container border border-outline-variant/30 rounded-lg px-md py-xs text-body-sm outline-none">
                  <option value="all">All statuses</option>
                  {statuses.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
                {filters.month && <button onClick={() => setFilters({ ...filters, month: '' })} className="bg-surface-container text-on-surface-variant rounded-lg px-md py-xs text-label-sm">All time</button>}
              </div>
            </div>

            <div className="bg-surface-container-lowest rounded-xl border border-outline-variant/20 overflow-hidden">
              <div className="px-lg py-md border-b border-outline-variant/20 flex items-center gap-sm">
                <span className="material-symbols-outlined text-secondary">fact_check</span>
                <h3 className="text-headline-sm text-primary">Bill Register</h3>
              </div>
              {loading ? (
                <div className="py-xl text-center text-on-surface-variant">Loading...</div>
              ) : !data || data.bills.length === 0 ? (
                <div className="py-xl text-center text-on-surface-variant">No bills recorded.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-outline-variant/20 bg-surface-container-low/40">
                        {['Vendor', 'Invoice', 'Recognition', 'Category', 'Amount', 'Labels', 'Status', 'Document', ''].map(h => (
                          <th key={h} className="text-left px-lg py-sm text-label-sm text-on-surface-variant uppercase tracking-wider">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-outline-variant/10">
                      {data.bills.map(bill => (
                        <tr key={bill.id} className="hover:bg-surface-container-low/40">
                          <td className="px-lg py-md">
                            <p className="text-label-md text-primary">{bill.vendorName}</p>
                            <p className="text-label-sm text-on-surface-variant">{bill.description || bill.expenseAccount}</p>
                          </td>
                          <td className="px-lg py-md text-body-sm text-on-surface-variant">
                            <p>{bill.invoiceNumber || '-'}</p>
                            <p>{fmt(bill.billDate)}</p>
                          </td>
                          <td className="px-lg py-md text-body-sm text-on-surface-variant">
                            <p>{fmt(bill.recognitionDate)}</p>
                            <p>{bill.accountingBasis}</p>
                          </td>
                          <td className="px-lg py-md text-body-sm text-on-surface-variant">{categoryLabel(bill.category)}</td>
                          <td className="px-lg py-md">
                            <p className="text-label-md text-primary">{fmtUSD(bill.totalAmount, bill.currency)}</p>
                            <p className="text-label-sm text-on-surface-variant">Tax {fmtUSD(bill.taxAmount, bill.currency)}</p>
                          </td>
                          <td className="px-lg py-md">
                            <div className="flex flex-wrap gap-xs max-w-[220px]">
                              {bill.project && <span className="bg-secondary/10 text-secondary px-sm py-xs rounded-full text-label-sm">{bill.project.name}</span>}
                              {bill.staff && <span className="bg-surface-container text-on-surface-variant px-sm py-xs rounded-full text-label-sm">{bill.staff.name}</span>}
                              {!bill.project && !bill.staff && <span className="text-on-surface-variant">-</span>}
                            </div>
                          </td>
                          <td className="px-lg py-md">
                            <span className={`${statusClass(bill.paymentStatus)} rounded-full px-sm py-xs text-label-sm`}>{bill.paymentStatus}</span>
                          </td>
                          <td className="px-lg py-md">
                            {bill.documentUrl ? <a href={bill.documentUrl} target="_blank" rel="noreferrer" className="text-secondary text-label-sm hover:underline">{bill.documentName || 'Open'}</a> : <span className="text-on-surface-variant">-</span>}
                          </td>
                          <td className="px-lg py-md">
                            <button onClick={() => deleteBill(bill.id)} className="text-error text-label-sm hover:underline">Delete</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>
        </div>
      </main>
    </div>
    </RoleGate>
  )
}

function FieldGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-md">
      <h4 className="text-label-md text-primary uppercase tracking-wider">{title}</h4>
      {children}
    </section>
  )
}

function TextInput({ label, ...props }: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block">
      <span className="block text-label-sm text-on-surface-variant mb-xs">{label}{props.required ? ' *' : ''}</span>
      <input {...props} className="w-full bg-surface-container border border-outline-variant/30 rounded-lg px-md py-xs text-body-sm focus:ring-2 focus:ring-secondary outline-none" />
    </label>
  )
}

function SelectInput({ label, options, ...props }: { label: string; options: string[][] } & React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <label className="block">
      <span className="block text-label-sm text-on-surface-variant mb-xs">{label}{props.required ? ' *' : ''}</span>
      <select {...props} className="w-full bg-surface-container border border-outline-variant/30 rounded-lg px-md py-xs text-body-sm focus:ring-2 focus:ring-secondary outline-none">
        {options.map(([value, text]) => <option key={value || text} value={value}>{text}</option>)}
      </select>
    </label>
  )
}

function TextArea({ label, ...props }: { label: string } & React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <label className="block">
      <span className="block text-label-sm text-on-surface-variant mb-xs">{label}</span>
      <textarea {...props} rows={2} className="w-full bg-surface-container border border-outline-variant/30 rounded-lg px-md py-xs text-body-sm focus:ring-2 focus:ring-secondary outline-none resize-none" />
    </label>
  )
}

function StatCard({ label, icon, value, hint }: { label: string; icon: string; value: string; hint: string }) {
  return (
    <div className="bg-surface-container-lowest rounded-xl border border-outline-variant/20 p-lg">
      <div className="flex items-center gap-sm mb-sm">
        <span className="material-symbols-outlined text-[18px] text-secondary">{icon}</span>
        <span className="text-label-sm uppercase tracking-wider text-on-surface-variant">{label}</span>
      </div>
      <p className="text-stats-lg text-primary">{value}</p>
      <p className="text-label-sm mt-xs text-on-surface-variant">{hint}</p>
    </div>
  )
}
