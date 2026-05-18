'use client'
import { FormEvent, useCallback, useEffect, useState } from 'react'
import Sidebar from '@/components/Sidebar'
import { RoleGate } from '@/components/RoleGate'

type Project = { id: string; name: string }
type Staff = { id: string; name: string; role: string | null }
type FulfillmentCost = {
  id: string
  providerName: string
  invoiceNumber: string | null
  billDate: string
  serviceStartDate: string | null
  serviceEndDate: string | null
  recognitionDate: string
  costType: string
  currency: string
  orderCount: number
  itemCount: number
  productCost: number
  pickPackCost: number
  shippingCost: number
  storageCost: number
  returnCost: number
  adjustmentAmount: number
  taxAmount: number
  totalAmount: number
  paymentStatus: string
  documentUrl: string | null
  documentName: string | null
  project: Project | null
  staff: Staff | null
}

type Data = {
  costs: FulfillmentCost[]
  projects: Project[]
  staff: Staff[]
  costTypes: string[]
  paymentStatuses: string[]
  stats: {
    total: number
    paid: number
    payable: number
    count: number
    orderCount: number
    itemCount: number
    costPerOrder: number
    productCost: number
    shippingCost: number
    pickPackCost: number
  }
}

const TYPE_LABELS: Record<string, string> = {
  PRODUCT_COST: 'Product cost',
  PICK_PACK: 'Pick & pack',
  SHIPPING: 'Shipping',
  STORAGE: 'Storage',
  RETURNS: 'Returns',
  MIXED: 'Mixed invoice',
  ADJUSTMENT: 'Adjustment',
}

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

function typeLabel(type: string) {
  return TYPE_LABELS[type] ?? type
}

function statusClass(status: string) {
  if (status === 'PAID') return 'bg-on-tertiary-container/15 text-on-tertiary-container'
  if (status === 'PARTIAL') return 'bg-secondary/10 text-secondary'
  if (status === 'VOID') return 'bg-surface-container text-on-surface-variant'
  return 'bg-error/10 text-error'
}

export default function FulfillmentPage() {
  const [data, setData] = useState<Data | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [filters, setFilters] = useState({ month: '', projectId: 'all', costType: 'all', status: 'all' })

  const load = useCallback(async () => {
    setLoading(true)
    const params = new URLSearchParams()
    if (filters.month) params.set('month', filters.month)
    if (filters.projectId !== 'all') params.set('projectId', filters.projectId)
    if (filters.costType !== 'all') params.set('costType', filters.costType)
    if (filters.status !== 'all') params.set('status', filters.status)
    const res = await fetch(`/api/finance/fulfillment?${params}`)
    setData(await res.json())
    setLoading(false)
  }, [filters])

  useEffect(() => { load() }, [load])

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setSaving(true)
    setMessage(null)
    const form = new FormData(e.currentTarget)
    const res = await fetch('/api/finance/fulfillment', { method: 'POST', body: form })
    const json = await res.json()
    if (!res.ok) {
      setMessage(json.error || 'Could not save fulfillment cost')
      setSaving(false)
      return
    }
    e.currentTarget.reset()
    setMessage('Fulfillment cost saved.')
    await load()
    setSaving(false)
  }

  async function deleteCost(id: string) {
    await fetch(`/api/finance/fulfillment/${id}`, { method: 'DELETE' })
    await load()
  }

  const projects = data?.projects ?? []
  const staff = data?.staff ?? []
  const costTypes = data?.costTypes ?? Object.keys(TYPE_LABELS)
  const statuses = data?.paymentStatuses ?? ['UNPAID', 'PARTIAL', 'PAID', 'VOID']

  return (
    <RoleGate>
    <div className="flex min-h-screen bg-surface">
      <Sidebar />
      <main className="ml-[280px] flex-1 p-xl">
        <header className="mb-xl">
          <h2 className="text-display-md font-bold text-primary">Fulfillment Cost</h2>
          <p className="text-on-surface-variant text-body-md mt-xs">Separate landed fulfillment expenses for product, pick-pack, shipping, storage, returns, and adjustments</p>
        </header>

        <div className="grid grid-cols-1 xl:grid-cols-[420px_1fr] gap-xl items-start">
          <form onSubmit={submit} className="bg-surface-container-lowest rounded-xl border border-outline-variant/20 overflow-hidden">
            <div className="px-lg py-md border-b border-outline-variant/20 flex items-center gap-sm">
              <span className="material-symbols-outlined text-secondary">local_shipping</span>
              <h3 className="text-headline-sm text-primary">Add Fulfillment Cost</h3>
            </div>
            <div className="p-lg space-y-lg">
              <FieldGroup title="Provider & Period">
                <TextInput name="providerName" label="3PL / supplier / carrier" required />
                <TextInput name="invoiceNumber" label="Invoice number" />
                <div className="grid grid-cols-2 gap-md">
                  <TextInput name="billDate" label="Bill date" type="date" required defaultValue={today()} />
                  <TextInput name="recognitionDate" label="Recognition date" type="date" required defaultValue={today()} />
                </div>
                <div className="grid grid-cols-2 gap-md">
                  <TextInput name="serviceStartDate" label="Service start" type="date" />
                  <TextInput name="serviceEndDate" label="Service end" type="date" />
                </div>
                <input name="document" type="file" accept="application/pdf,image/*,.csv,.xlsx,.xls" className="block w-full text-body-sm text-on-surface-variant file:mr-md file:rounded-lg file:border-0 file:bg-secondary file:px-md file:py-xs file:text-on-secondary file:text-label-sm" />
              </FieldGroup>

              <FieldGroup title="Operational Driver">
                <div className="grid grid-cols-3 gap-md">
                  <SelectInput name="costType" label="Cost type" options={costTypes.map(t => [t, typeLabel(t)])} required />
                  <TextInput name="orderCount" label="Orders" type="number" defaultValue="0" />
                  <TextInput name="itemCount" label="Items" type="number" defaultValue="0" />
                </div>
              </FieldGroup>

              <FieldGroup title="Cost Breakdown">
                <div className="grid grid-cols-3 gap-md">
                  <TextInput name="currency" label="Currency" defaultValue="USD" required />
                  <TextInput name="productCost" label="Product" type="number" step="0.01" defaultValue="0" />
                  <TextInput name="pickPackCost" label="Pick-pack" type="number" step="0.01" defaultValue="0" />
                  <TextInput name="shippingCost" label="Shipping" type="number" step="0.01" defaultValue="0" />
                  <TextInput name="storageCost" label="Storage" type="number" step="0.01" defaultValue="0" />
                  <TextInput name="returnCost" label="Returns" type="number" step="0.01" defaultValue="0" />
                  <TextInput name="adjustmentAmount" label="Adjustment" type="number" step="0.01" defaultValue="0" />
                  <TextInput name="taxAmount" label="Tax" type="number" step="0.01" defaultValue="0" />
                  <TextInput name="totalAmount" label="Total override" type="number" step="0.01" />
                </div>
              </FieldGroup>

              <FieldGroup title="Payment & Labels">
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
                <TextArea name="notes" label="Notes" />
              </FieldGroup>

              {message && <p className={`text-body-sm ${message.includes('required') || message.includes('Valid') ? 'text-error' : 'text-on-tertiary-container'}`}>{message}</p>}
              <button disabled={saving} className="w-full bg-secondary text-on-secondary rounded-lg py-md text-label-md font-semibold disabled:opacity-50">
                {saving ? 'Saving...' : 'Save Fulfillment Cost'}
              </button>
            </div>
          </form>

          <section className="space-y-lg">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-lg">
              <StatCard label="Total cost" value={fmtUSD(data?.stats.total ?? 0)} hint={`${data?.stats.count ?? 0} records`} icon="local_shipping" />
              <StatCard label="Cost / order" value={fmtUSD(data?.stats.costPerOrder ?? 0)} hint={`${data?.stats.orderCount ?? 0} orders`} icon="receipt" />
              <StatCard label="Shipping" value={fmtUSD(data?.stats.shippingCost ?? 0)} hint="carrier charges" icon="local_shipping" />
              <StatCard label="Open payable" value={fmtUSD(data?.stats.payable ?? 0)} hint="unpaid + partial" icon="schedule" />
            </div>

            <div className="bg-surface-container-lowest rounded-xl border border-outline-variant/20 p-lg">
              <div className="flex items-center gap-md flex-wrap">
                <span className="material-symbols-outlined text-[18px] text-on-surface-variant">filter_alt</span>
                <input type="month" value={filters.month} onChange={e => setFilters({ ...filters, month: e.target.value })} className="bg-surface-container border border-outline-variant/30 rounded-lg px-md py-xs text-body-sm outline-none" />
                <select value={filters.projectId} onChange={e => setFilters({ ...filters, projectId: e.target.value })} className="bg-surface-container border border-outline-variant/30 rounded-lg px-md py-xs text-body-sm outline-none">
                  <option value="all">All projects</option>
                  {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <select value={filters.costType} onChange={e => setFilters({ ...filters, costType: e.target.value })} className="bg-surface-container border border-outline-variant/30 rounded-lg px-md py-xs text-body-sm outline-none">
                  <option value="all">All cost types</option>
                  {costTypes.map(t => <option key={t} value={t}>{typeLabel(t)}</option>)}
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
                <span className="material-symbols-outlined text-secondary">table_chart</span>
                <h3 className="text-headline-sm text-primary">Fulfillment Register</h3>
              </div>
              {loading ? (
                <div className="py-xl text-center text-on-surface-variant">Loading...</div>
              ) : !data || data.costs.length === 0 ? (
                <div className="py-xl text-center text-on-surface-variant">No fulfillment costs recorded.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-outline-variant/20 bg-surface-container-low/40">
                        {['Provider', 'Period', 'Type', 'Drivers', 'Total', 'Labels', 'Status', 'Document', ''].map(h => (
                          <th key={h} className="text-left px-lg py-sm text-label-sm text-on-surface-variant uppercase tracking-wider">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-outline-variant/10">
                      {data.costs.map(cost => (
                        <tr key={cost.id} className="hover:bg-surface-container-low/40">
                          <td className="px-lg py-md">
                            <p className="text-label-md text-primary">{cost.providerName}</p>
                            <p className="text-label-sm text-on-surface-variant">{cost.invoiceNumber || '-'}</p>
                          </td>
                          <td className="px-lg py-md text-body-sm text-on-surface-variant">
                            <p>{fmt(cost.recognitionDate)}</p>
                            <p>{fmt(cost.serviceStartDate)} to {fmt(cost.serviceEndDate)}</p>
                          </td>
                          <td className="px-lg py-md text-body-sm text-on-surface-variant">{typeLabel(cost.costType)}</td>
                          <td className="px-lg py-md text-body-sm text-on-surface-variant">
                            <p>{cost.orderCount} orders</p>
                            <p>{cost.itemCount} items</p>
                          </td>
                          <td className="px-lg py-md">
                            <p className="text-label-md text-primary">{fmtUSD(cost.totalAmount, cost.currency)}</p>
                            <p className="text-label-sm text-on-surface-variant">Ship {fmtUSD(cost.shippingCost, cost.currency)}</p>
                          </td>
                          <td className="px-lg py-md">
                            <div className="flex flex-wrap gap-xs max-w-[220px]">
                              {cost.project && <span className="bg-secondary/10 text-secondary px-sm py-xs rounded-full text-label-sm">{cost.project.name}</span>}
                              {cost.staff && <span className="bg-surface-container text-on-surface-variant px-sm py-xs rounded-full text-label-sm">{cost.staff.name}</span>}
                              {!cost.project && !cost.staff && <span className="text-on-surface-variant">-</span>}
                            </div>
                          </td>
                          <td className="px-lg py-md">
                            <span className={`${statusClass(cost.paymentStatus)} rounded-full px-sm py-xs text-label-sm`}>{cost.paymentStatus}</span>
                          </td>
                          <td className="px-lg py-md">
                            {cost.documentUrl ? <a href={cost.documentUrl} target="_blank" rel="noreferrer" className="text-secondary text-label-sm hover:underline">{cost.documentName || 'Open'}</a> : <span className="text-on-surface-variant">-</span>}
                          </td>
                          <td className="px-lg py-md">
                            <button onClick={() => deleteCost(cost.id)} className="text-error text-label-sm hover:underline">Delete</button>
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
