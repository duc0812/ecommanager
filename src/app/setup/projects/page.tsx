'use client'
import { useEffect, useState } from 'react'
import Sidebar from '@/components/Sidebar'

type Assignment = {
  id: string
  staffId: string
  startDate: string
  endDate: string | null
  staff: { id: string; name: string; role: string | null }
}

type Project = {
  id: string
  name: string
  startDate: string
  description: string | null
  assignments: Assignment[]
}

function fmt(dateStr: string) {
  return new Date(dateStr).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

export default function SetupProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [pName, setPName] = useState('')
  const [pStart, setPStart] = useState('')
  const [pDesc, setPDesc] = useState('')
  const [saving, setSaving] = useState(false)

  async function load() {
    setLoading(true)
    const data = await fetch('/api/projects').then(r => r.json())
    setProjects(Array.isArray(data) ? data : [])
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  async function createProject() {
    if (!pName || !pStart) return
    setSaving(true)
    await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: pName, startDate: pStart, description: pDesc }),
    })
    setPName(''); setPStart(''); setPDesc('')
    await load()
    setSaving(false)
  }

  async function deleteProject(id: string) {
    if (!confirm('Xóa project này?')) return
    await fetch('/api/projects', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })
    await load()
  }

  const inputCls = 'bg-surface-container border border-outline-variant/30 rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-secondary focus:border-secondary outline-none transition-all w-full'

  return (
    <div className="flex min-h-screen bg-surface">
      <Sidebar />
      <main className="ml-[280px] flex-1 p-xl max-w-[860px]">
        <header className="mb-xl">
          <p className="text-label-sm text-on-surface-variant uppercase tracking-wider mb-xs">Setup</p>
          <h2 className="text-display-md font-bold text-primary">Projects</h2>
          <p className="text-on-surface-variant text-body-md mt-xs">Tạo và quản lý các dự án</p>
        </header>

        {/* Create */}
        <div className="bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20 overflow-hidden mb-xl">
          <div className="flex items-center gap-sm px-lg py-md border-b border-outline-variant/20">
            <span className="material-symbols-outlined text-secondary">add_circle</span>
            <h3 className="text-headline-sm text-primary">Tạo Project mới</h3>
          </div>
          <div className="p-lg grid grid-cols-1 md:grid-cols-3 gap-md">
            <div className="space-y-xs">
              <label className="block text-label-sm text-on-surface-variant uppercase tracking-wider">Tên project *</label>
              <input type="text" value={pName} onChange={e => setPName(e.target.value)} placeholder="VD: POD, Dropship US..." className={inputCls} />
            </div>
            <div className="space-y-xs">
              <label className="block text-label-sm text-on-surface-variant uppercase tracking-wider">Ngày bắt đầu *</label>
              <input type="date" value={pStart} onChange={e => setPStart(e.target.value)} className={inputCls} />
            </div>
            <div className="space-y-xs">
              <label className="block text-label-sm text-on-surface-variant uppercase tracking-wider">Mô tả</label>
              <input type="text" value={pDesc} onChange={e => setPDesc(e.target.value)} placeholder="Ghi chú thêm..." className={inputCls} />
            </div>
            <div className="md:col-span-3">
              <button
                onClick={createProject}
                disabled={saving || !pName || !pStart}
                className="flex items-center gap-sm bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md hover:opacity-90 disabled:opacity-40 transition-opacity"
              >
                <span className={`material-symbols-outlined text-[18px] ${saving ? 'animate-spin' : ''}`}>{saving ? 'sync' : 'add_circle'}</span>
                {saving ? 'Đang lưu...' : 'Tạo Project'}
              </button>
            </div>
          </div>
        </div>

        {/* List */}
        <div className="bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20 overflow-hidden">
          <div className="flex items-center gap-sm px-lg py-md border-b border-outline-variant/20">
            <span className="material-symbols-outlined text-secondary">folder_open</span>
            <h3 className="text-headline-sm text-primary">Danh sách Projects</h3>
            <span className="ml-auto bg-surface-container-high px-sm py-xs rounded text-label-sm text-on-surface-variant">{projects.length}</span>
          </div>
          {loading ? (
            <div className="px-lg py-xl text-center">
              <span className="material-symbols-outlined animate-spin text-[24px] text-on-surface-variant">sync</span>
            </div>
          ) : projects.length === 0 ? (
            <div className="px-lg py-xl text-center text-on-surface-variant text-body-sm">Chưa có project nào</div>
          ) : (
            <div className="divide-y divide-outline-variant/10">
              {projects.map(p => (
                <div key={p.id} className="flex items-start justify-between px-lg py-md hover:bg-surface-container-low/50 transition-colors">
                  <div className="flex-1">
                    <div className="flex items-center gap-sm mb-xs flex-wrap">
                      <h4 className="text-label-md text-primary">{p.name}</h4>
                      <span className="bg-secondary/10 text-secondary px-sm py-xs rounded-full text-label-sm">Từ {fmt(p.startDate)}</span>
                    </div>
                    {p.description && <p className="text-body-sm text-on-surface-variant mb-xs">{p.description}</p>}
                    {p.assignments.length > 0 && (
                      <div className="flex flex-wrap gap-xs">
                        {p.assignments.map(a => (
                          <span key={a.id} className="flex items-center gap-xs bg-surface-container rounded-lg px-sm py-xs">
                            <span className="material-symbols-outlined text-[12px] text-on-surface-variant">person</span>
                            <span className="text-label-sm text-on-surface">{a.staff.name}</span>
                            <span className="text-label-sm text-on-surface-variant">từ {fmt(a.startDate)}</span>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <button onClick={() => deleteProject(p.id)} className="text-error/60 hover:text-error transition-colors ml-md mt-xs">
                    <span className="material-symbols-outlined text-[18px]">delete</span>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
