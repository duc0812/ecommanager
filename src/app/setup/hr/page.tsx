'use client'
import { useEffect, useState } from 'react'
import Sidebar from '@/components/Sidebar'

type Project = { id: string; name: string }

type Staff = {
  id: string
  name: string
  role: string | null
  monthlyCost: number
  note: string | null
  assignments: { id: string; projectId: string; startDate: string; endDate: string | null; project: { name: string } }[]
}

function fmt(dateStr: string) {
  return new Date(dateStr).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

export default function SetupHRPage() {
  const [staff, setStaff] = useState<Staff[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)

  const [sName, setSName] = useState('')
  const [sRole, setSRole] = useState('')
  const [sCost, setSCost] = useState('')
  const [sNote, setSNote] = useState('')
  const [sSaving, setSSaving] = useState(false)

  const [assignStaffId, setAssignStaffId] = useState('')
  const [assignProjectId, setAssignProjectId] = useState('')
  const [assignStart, setAssignStart] = useState('')
  const [assignSaving, setAssignSaving] = useState(false)

  async function load() {
    setLoading(true)
    const [s, p] = await Promise.all([
      fetch('/api/staff').then(r => r.json()),
      fetch('/api/projects').then(r => r.json()),
    ])
    setStaff(Array.isArray(s) ? s : [])
    setProjects(Array.isArray(p) ? p : [])
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  async function createStaff() {
    if (!sName) return
    setSSaving(true)
    await fetch('/api/staff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: sName, role: sRole, monthlyCost: sCost, note: sNote }),
    })
    setSName(''); setSRole(''); setSCost(''); setSNote('')
    await load()
    setSSaving(false)
  }

  async function deleteStaff(id: string) {
    if (!confirm('Xóa nhân sự này?')) return
    await fetch('/api/staff', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })
    await load()
  }

  async function assignStaff() {
    if (!assignStaffId || !assignProjectId || !assignStart) return
    setAssignSaving(true)
    await fetch('/api/projects/assign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ staffId: assignStaffId, projectId: assignProjectId, startDate: assignStart }),
    })
    setAssignStaffId(''); setAssignProjectId(''); setAssignStart('')
    await load()
    setAssignSaving(false)
  }

  async function removeAssignment(staffId: string, projectId: string) {
    if (!confirm('Gỡ khỏi project này?')) return
    await fetch('/api/projects/assign', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ staffId, projectId }),
    })
    await load()
  }

  const inputCls = 'bg-surface-container border border-outline-variant/30 rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-secondary focus:border-secondary outline-none transition-all w-full'

  return (
    <div className="flex min-h-screen bg-surface">
      <Sidebar />
      <main className="ml-[280px] flex-1 p-xl">
        <header className="mb-xl">
          <p className="text-label-sm text-on-surface-variant uppercase tracking-wider mb-xs">Setup</p>
          <h2 className="text-display-md font-bold text-primary">HR</h2>
          <p className="text-on-surface-variant text-body-md mt-xs">Quản lý nhân sự và phân công dự án</p>
        </header>

        <div className="grid grid-cols-12 gap-lg">

          {/* Left: Add staff */}
          <section className="col-span-12 lg:col-span-6 space-y-lg">

            <div className="bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20 overflow-hidden">
              <div className="flex items-center gap-sm px-lg py-md border-b border-outline-variant/20">
                <span className="material-symbols-outlined text-secondary">person_add</span>
                <h3 className="text-headline-sm text-primary">Thêm Nhân sự</h3>
              </div>
              <div className="p-lg space-y-md">
                <div className="grid grid-cols-2 gap-md">
                  <div className="space-y-xs">
                    <label className="block text-label-sm text-on-surface-variant uppercase tracking-wider">Họ tên *</label>
                    <input type="text" value={sName} onChange={e => setSName(e.target.value)} placeholder="VD: Nghĩa" className={inputCls} />
                  </div>
                  <div className="space-y-xs">
                    <label className="block text-label-sm text-on-surface-variant uppercase tracking-wider">Vai trò</label>
                    <input type="text" value={sRole} onChange={e => setSRole(e.target.value)} placeholder="VD: Seller, Designer..." className={inputCls} />
                  </div>
                </div>
                <div className="space-y-xs">
                  <label className="block text-label-sm text-on-surface-variant uppercase tracking-wider">Chi phí / tháng (USD)</label>
                  <input type="number" value={sCost} onChange={e => setSCost(e.target.value)} placeholder="0" min="0" step="0.01" className={inputCls} />
                </div>
                <div className="space-y-xs">
                  <label className="block text-label-sm text-on-surface-variant uppercase tracking-wider">Ghi chú</label>
                  <input type="text" value={sNote} onChange={e => setSNote(e.target.value)} placeholder="Thông tin thêm..." className={inputCls} />
                </div>
                <button
                  onClick={createStaff}
                  disabled={sSaving || !sName}
                  className="flex items-center gap-sm bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md hover:opacity-90 disabled:opacity-40 transition-opacity"
                >
                  <span className={`material-symbols-outlined text-[18px] ${sSaving ? 'animate-spin' : ''}`}>{sSaving ? 'sync' : 'person_add'}</span>
                  {sSaving ? 'Đang lưu...' : 'Thêm Nhân sự'}
                </button>
              </div>
            </div>

            {/* Assign */}
            <div className="bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20 overflow-hidden">
              <div className="flex items-center gap-sm px-lg py-md border-b border-outline-variant/20">
                <span className="material-symbols-outlined text-secondary">assignment_ind</span>
                <h3 className="text-headline-sm text-primary">Gán Nhân sự vào Project</h3>
              </div>
              <div className="p-lg space-y-md">
                <div className="space-y-xs">
                  <label className="block text-label-sm text-on-surface-variant uppercase tracking-wider">Nhân sự</label>
                  <select value={assignStaffId} onChange={e => setAssignStaffId(e.target.value)} className={inputCls}>
                    <option value="">-- Chọn nhân sự --</option>
                    {staff.map(s => <option key={s.id} value={s.id}>{s.name}{s.role ? ` (${s.role})` : ''}</option>)}
                  </select>
                </div>
                <div className="space-y-xs">
                  <label className="block text-label-sm text-on-surface-variant uppercase tracking-wider">Project</label>
                  <select value={assignProjectId} onChange={e => setAssignProjectId(e.target.value)} className={inputCls}>
                    <option value="">-- Chọn project --</option>
                    {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
                <div className="space-y-xs">
                  <label className="block text-label-sm text-on-surface-variant uppercase tracking-wider">Ngày bắt đầu làm việc</label>
                  <input type="date" value={assignStart} onChange={e => setAssignStart(e.target.value)} className={inputCls} />
                </div>
                <p className="text-label-sm text-on-surface-variant flex items-center gap-xs">
                  <span className="material-symbols-outlined text-[14px] text-secondary">info</span>
                  Payout sau ngày này sẽ được auto-label theo nhân sự đã chọn
                </p>
                <button
                  onClick={assignStaff}
                  disabled={assignSaving || !assignStaffId || !assignProjectId || !assignStart}
                  className="flex items-center gap-sm bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md hover:opacity-90 disabled:opacity-40 transition-opacity"
                >
                  <span className={`material-symbols-outlined text-[18px] ${assignSaving ? 'animate-spin' : ''}`}>{assignSaving ? 'sync' : 'link'}</span>
                  {assignSaving ? 'Đang gán...' : 'Gán vào Project'}
                </button>
              </div>
            </div>

          </section>

          {/* Right: Staff list */}
          <section className="col-span-12 lg:col-span-6">
            <div className="bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20 overflow-hidden">
              <div className="flex items-center gap-sm px-lg py-md border-b border-outline-variant/20">
                <span className="material-symbols-outlined text-secondary">group</span>
                <h3 className="text-headline-sm text-primary">Danh sách Nhân sự</h3>
                <span className="ml-auto bg-surface-container-high px-sm py-xs rounded text-label-sm text-on-surface-variant">{staff.length}</span>
              </div>
              {loading ? (
                <div className="px-lg py-xl text-center">
                  <span className="material-symbols-outlined animate-spin text-[24px] text-on-surface-variant">sync</span>
                </div>
              ) : staff.length === 0 ? (
                <div className="px-lg py-xl text-center text-on-surface-variant text-body-sm">Chưa có nhân sự nào</div>
              ) : (
                <div className="divide-y divide-outline-variant/10">
                  {staff.map(s => (
                    <div key={s.id} className="px-lg py-md hover:bg-surface-container-low/50 transition-colors">
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <div className="flex items-center gap-sm flex-wrap mb-xs">
                            <span className="text-label-md text-primary">{s.name}</span>
                            {s.role && <span className="bg-surface-container text-on-surface-variant px-sm py-xs rounded-full text-label-sm">{s.role}</span>}
                            {s.monthlyCost > 0 && <span className="bg-secondary/10 text-secondary px-sm py-xs rounded-full text-label-sm">${s.monthlyCost.toFixed(0)}/tháng</span>}
                          </div>
                          {s.note && <p className="text-body-sm text-on-surface-variant mb-xs">{s.note}</p>}
                          {s.assignments.length > 0 && (
                            <div className="flex flex-wrap gap-xs">
                              {s.assignments.map(a => (
                                <span key={a.id} className="flex items-center gap-xs bg-surface-container-low rounded-lg px-sm py-xs">
                                  <span className="material-symbols-outlined text-[12px] text-on-surface-variant">folder</span>
                                  <span className="text-label-sm text-on-surface">{a.project.name}</span>
                                  <span className="text-label-sm text-on-surface-variant">từ {fmt(a.startDate)}</span>
                                  <button onClick={() => removeAssignment(s.id, a.projectId)} className="text-error/60 hover:text-error ml-xs">
                                    <span className="material-symbols-outlined text-[12px]">close</span>
                                  </button>
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                        <button onClick={() => deleteStaff(s.id)} className="text-error/60 hover:text-error transition-colors ml-md mt-xs">
                          <span className="material-symbols-outlined text-[18px]">delete</span>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

        </div>
      </main>
    </div>
  )
}
