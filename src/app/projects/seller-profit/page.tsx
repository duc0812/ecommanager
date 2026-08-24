'use client'
import { useEffect, useState } from 'react'
import Sidebar from '@/components/Sidebar'
import { RoleGate, useCurrentUser } from '@/components/RoleGate'

type Staff = { id: string; name: string; role: string | null }
type Assignment = { staffId: string; staff: Staff }
type Project = { id: string; name: string; assignments: Assignment[] }
type SellerCommRow = { month: string; realized: number; cumulative: number; baseline: number; profit: number; met: boolean; rate: number; commission: number }
type SellerCommData = { staff: Staff; period: { start: string; end: string }; months: SellerCommRow[]; totalCommission: number; error?: string }

function fmtUSD(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(n || 0)
}
function fmtMonthLabel(m: string) {
  const [y, mo] = m.split('-')
  return `${mo}/${y}`
}

export default function SellerProfitPage() {
  const { user } = useCurrentUser()
  const isSuperAdmin = user?.role === 'SUPERADMIN'
  const [projects, setProjects] = useState<Project[]>([])
  const [projectId, setProjectId] = useState('')
  const [staffId, setStaffId] = useState('')
  const [data, setData] = useState<SellerCommData | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    fetch('/api/projects').then(r => r.json()).then((d: Project[]) => {
      const list = Array.isArray(d) ? d : []
      setProjects(list)
      if (list.length) setProjectId(list[0].id)
    }).catch(() => {})
  }, [])

  const project = projects.find(p => p.id === projectId)
  const sellers = project ? Array.from(new Map(project.assignments.map(a => [a.staffId, a.staff])).values()) : []

  useEffect(() => {
    if (project && project.assignments.length > 0) {
      setStaffId(prev => (project.assignments.some(a => a.staffId === prev) ? prev : project.assignments[0].staffId))
    } else {
      setStaffId('')
    }
  }, [projectId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!projectId || !staffId) { setData(null); return }
    setLoading(true)
    fetch(`/api/projects/seller-commission?projectId=${projectId}&staffId=${staffId}`)
      .then(r => r.json())
      .then((d: SellerCommData) => { setData(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [projectId, staffId])

  return (
    <RoleGate>
      <div className="flex min-h-screen bg-surface">
        <Sidebar />
        <main className="ml-0 lg:ml-[280px] mt-14 lg:mt-0 flex-1 p-xl">
          <header className="mb-xl">
            <h2 className="text-display-md font-bold text-primary">Seller Profit</h2>
            <p className="text-on-surface-variant text-body-md mt-xs">Hoa hồng seller theo cashflow thực · KPI $1,000 · % trên toàn bộ profit (10/15/20%)</p>
          </header>

          {!isSuperAdmin ? (
            <div className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-xl text-center">
              <span className="material-symbols-outlined text-[40px] text-on-surface-variant/40">lock</span>
              <p className="text-on-surface-variant mt-md text-body-md">Chỉ Super Admin mới xem được trang này.</p>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-md mb-lg">
                <div className="flex items-center gap-sm">
                  <span className="material-symbols-outlined text-[16px] text-on-surface-variant">folder</span>
                  <span className="text-label-sm text-on-surface-variant">Project:</span>
                  <select value={projectId} onChange={e => setProjectId(e.target.value)}
                    className="bg-surface-container border border-outline-variant/30 rounded-lg px-md py-sm text-body-sm outline-none focus:ring-2 focus:ring-secondary">
                    {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
                <div className="flex items-center gap-sm">
                  <span className="material-symbols-outlined text-[16px] text-on-surface-variant">person</span>
                  <span className="text-label-sm text-on-surface-variant">Seller:</span>
                  <select value={staffId} onChange={e => setStaffId(e.target.value)}
                    className="bg-surface-container border border-outline-variant/30 rounded-lg px-md py-sm text-body-sm outline-none focus:ring-2 focus:ring-secondary">
                    {sellers.length === 0 && <option value="">— chưa có seller —</option>}
                    {sellers.map(s => <option key={s.id} value={s.id}>{s.name}{s.role ? ` · ${s.role}` : ''}</option>)}
                  </select>
                </div>
              </div>

              <section className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest overflow-hidden">
                <div className="flex flex-wrap items-center gap-sm px-lg py-md border-b border-outline-variant/20">
                  <span className="material-symbols-outlined text-secondary">workspace_premium</span>
                  <h3 className="text-headline-sm text-primary">Hoa hồng theo tháng</h3>
                  {data && !data.error && data.months?.length > 0 && (
                    <span className="ml-auto rounded-lg bg-emerald-600 text-white px-md py-xs text-label-md font-bold tabular-nums">Tổng: {fmtUSD(data.totalCommission)}</span>
                  )}
                </div>
                {loading ? (
                  <div className="px-lg py-xl text-center text-on-surface-variant text-body-sm">Đang tính…</div>
                ) : !data || data.error || !data.months || data.months.length === 0 ? (
                  <div className="px-lg py-xl text-center text-on-surface-variant text-body-sm">{data?.error ? `Lỗi: ${data.error}` : 'Chưa có dữ liệu cho seller này.'}</div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-outline-variant/20 bg-surface-container-low/40">
                          {['Tháng', 'Cashflow thực', 'Lũy kế', 'Mốc phải vượt', 'Profit', 'Bậc', 'Hoa hồng'].map(h => (
                            <th key={h} className="text-left px-lg py-sm text-label-sm text-on-surface-variant uppercase tracking-wider">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-outline-variant/10">
                        {data.months.map(r => (
                          <tr key={r.month} className={`hover:bg-surface-container-low/40 transition-colors ${r.met ? '' : 'opacity-70'}`}>
                            <td className="px-lg py-md text-body-sm text-on-surface">{fmtMonthLabel(r.month)}</td>
                            <td className={`px-lg py-md text-body-sm tabular-nums ${r.realized < 0 ? 'text-error' : 'text-on-surface'}`}>{fmtUSD(r.realized)}</td>
                            <td className="px-lg py-md text-body-sm text-on-surface-variant tabular-nums">{fmtUSD(r.cumulative)}</td>
                            <td className="px-lg py-md text-body-sm text-on-surface-variant tabular-nums">{fmtUSD(r.baseline)}</td>
                            <td className={`px-lg py-md text-label-md font-semibold tabular-nums ${r.profit < 0 ? 'text-error' : 'text-primary'}`}>{fmtUSD(r.profit)}</td>
                            <td className="px-lg py-md text-body-sm">
                              {r.met
                                ? <span className="rounded-full bg-emerald-100 text-emerald-800 px-sm py-xs text-label-sm font-semibold">{Math.round(r.rate * 100)}%</span>
                                : <span className="rounded-full bg-surface-container text-on-surface-variant px-sm py-xs text-label-sm">Trượt KPI</span>}
                            </td>
                            <td className={`px-lg py-md text-label-md font-bold tabular-nums ${r.commission > 0 ? 'text-emerald-700' : 'text-on-surface-variant'}`}>{r.commission > 0 ? fmtUSD(r.commission) : '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="border-t-2 border-outline-variant/30 bg-surface-container-low/20">
                          <td colSpan={6} className="px-lg py-md text-label-md font-semibold text-primary">Tổng hoa hồng seller</td>
                          <td className="px-lg py-md text-label-md font-bold text-emerald-700 tabular-nums">{fmtUSD(data.totalCommission)}</td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}
              </section>
            </>
          )}
        </main>
      </div>
    </RoleGate>
  )
}
