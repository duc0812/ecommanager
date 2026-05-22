'use client'
import { useEffect, useState } from 'react'
import Sidebar from '@/components/Sidebar'
import { RoleGate } from '@/components/RoleGate'
import {
  accessSummary,
  DEFAULT_ROLE_PERMISSIONS,
  FeaturePermission,
  FEATURE_GROUPS,
  FEATURE_LABELS,
  ROLE_LABELS,
  UserRole,
} from '@/lib/roles'

type AppUser = {
  id: string
  name: string
  email: string
  role: UserRole
  permissions: FeaturePermission[]
  status: string
  createdAt: string
}

export default function UsersPage() {
  const [users, setUsers] = useState<AppUser[]>([])
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<UserRole>('SELLER')
  const [permissions, setPermissions] = useState<FeaturePermission[]>(DEFAULT_ROLE_PERMISSIONS.SELLER)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [passwordUserId, setPasswordUserId] = useState<string | null>(null)
  const [newPassword, setNewPassword] = useState('')
  const [passwordSaving, setPasswordSaving] = useState(false)
  const [passwordError, setPasswordError] = useState('')

  async function savePassword() {
    if (!passwordUserId || newPassword.length < 6) {
      setPasswordError('Password phải có ít nhất 6 ký tự')
      return
    }
    setPasswordSaving(true)
    setPasswordError('')
    const res = await fetch(`/api/users/${passwordUserId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: newPassword }),
    })
    if (res.ok) {
      setPasswordUserId(null)
      setNewPassword('')
    } else {
      const data = await res.json()
      setPasswordError(data.error || 'Lỗi khi lưu password')
    }
    setPasswordSaving(false)
  }

  async function load() {
    setUsers(await fetch('/api/users').then(r => r.json()))
  }

  useEffect(() => { load() }, [])

  function changeRole(next: UserRole) {
    setRole(next)
    setPermissions(DEFAULT_ROLE_PERMISSIONS[next])
  }

  function togglePermission(permission: FeaturePermission) {
    setPermissions(current => {
      if (current.includes(permission)) return current.filter(item => item !== permission)
      return [...current, permission]
    })
  }

  function editUser(user: AppUser) {
    setEditingId(user.id)
    setName(user.name)
    setEmail(user.email)
    setRole(user.role)
    setPermissions(user.permissions)
  }

  function resetForm() {
    setEditingId(null)
    setName('')
    setEmail('')
    setRole('SELLER')
    setPermissions(DEFAULT_ROLE_PERMISSIONS.SELLER)
  }

  async function saveUser() {
    if (!name || !email) return
    setSaving(true)
    await fetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, role, permissions }),
    })
    resetForm()
    await load()
    setSaving(false)
  }

  async function deleteUser(id: string) {
    await fetch('/api/users', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })
    await load()
  }

  return (
    <RoleGate>
    <div className="flex min-h-screen bg-surface">
      <Sidebar />
      <main className="ml-[280px] flex-1 p-xl">
        <header className="mb-xl">
          <p className="text-label-sm uppercase tracking-wider text-on-surface-variant">Setup</p>
          <h2 className="text-display-md font-bold text-primary">Users & Roles</h2>
          <p className="mt-xs text-body-md text-on-surface-variant">Super Admin grants feature access for each user.</p>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-xl">
          <section className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-lg">
            <h3 className="text-headline-sm text-primary mb-md">{editingId ? 'Edit User Access' : 'Add User'}</h3>
            <div className="space-y-md">
              <input value={name} onChange={e => setName(e.target.value)} placeholder="Name" className="w-full rounded-lg border border-outline-variant/30 bg-surface-container px-md py-sm outline-none" />
              <input value={email} onChange={e => setEmail(e.target.value)} placeholder="Email" disabled={!!editingId} className="w-full rounded-lg border border-outline-variant/30 bg-surface-container px-md py-sm outline-none disabled:opacity-60" />
              <select value={role} onChange={e => changeRole(e.target.value as UserRole)} className="w-full rounded-lg border border-outline-variant/30 bg-surface-container px-md py-sm outline-none">
                <option value="ADMIN">Admin</option>
                <option value="SELLER">Seller</option>
                <option value="SUPPORT">Support</option>
              </select>
              <div className="space-y-md rounded-lg border border-outline-variant/20 bg-surface-container-low p-md">
                <div className="flex items-center justify-between gap-md">
                  <p className="text-label-md font-semibold text-primary">Feature Access</p>
                  <button
                    onClick={() => setPermissions(DEFAULT_ROLE_PERMISSIONS[role])}
                    className="text-label-sm text-secondary hover:underline"
                    type="button"
                  >
                    Role default
                  </button>
                </div>
                {FEATURE_GROUPS.map(group => (
                  <div key={group.label}>
                    <p className="mb-xs text-label-sm uppercase tracking-wider text-on-surface-variant">{group.label}</p>
                    <div className="space-y-xs">
                      {group.permissions.map(permission => (
                        <label key={permission} className="flex cursor-pointer items-center gap-sm text-body-sm">
                          <input
                            type="checkbox"
                            checked={permissions.includes(permission)}
                            onChange={() => togglePermission(permission)}
                            className="h-4 w-4 accent-secondary"
                          />
                          <span>{FEATURE_LABELS[permission]}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              <div className="flex gap-sm">
                <button onClick={saveUser} disabled={saving || !name || !email} className="flex-1 rounded-lg bg-secondary py-md text-label-md font-semibold text-on-secondary disabled:opacity-50">
                  {saving ? 'Saving...' : editingId ? 'Update Access' : 'Save User'}
                </button>
                {editingId && (
                  <button onClick={resetForm} className="rounded-lg border border-outline-variant/30 px-md py-md text-label-md text-on-surface-variant">
                    Cancel
                  </button>
                )}
              </div>
            </div>
          </section>

          <section className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest overflow-hidden">
            <div className="border-b border-outline-variant/20 px-lg py-md">
              <h3 className="text-headline-sm text-primary">Access Matrix</h3>
            </div>
            <table className="w-full">
              <thead>
                <tr className="bg-surface-container-low/40 text-left">
                  {['User', 'Role', 'Access', 'Status', ''].map(h => <th key={h} className="px-lg py-sm text-label-sm uppercase tracking-wider text-on-surface-variant">{h}</th>)}
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant/10">
                {users.map(user => (
                  <tr key={user.id}>
                    <td className="px-lg py-md">
                      <p className="text-label-md text-primary">{user.name}</p>
                      <p className="text-label-sm text-on-surface-variant">{user.email}</p>
                    </td>
                    <td className="px-lg py-md text-body-sm">{ROLE_LABELS[user.role]}</td>
                    <td className="max-w-[420px] px-lg py-md text-body-sm text-on-surface-variant">
                      {accessSummary(user.role, user.permissions)}
                    </td>
                    <td className="px-lg py-md"><span className="rounded-full bg-on-tertiary-container/15 px-sm py-xs text-label-sm text-on-tertiary-container">{user.status}</span></td>
                    <td className="px-lg py-md text-right">
                      <div className="flex justify-end gap-sm">
                        <button onClick={() => { setPasswordUserId(user.id); setNewPassword(''); setPasswordError('') }} className="text-on-surface-variant text-label-sm hover:underline">Set Password</button>
                        {user.role !== 'SUPERADMIN' && (
                          <>
                            <button onClick={() => editUser(user)} className="text-secondary text-label-sm hover:underline">Edit</button>
                            <button onClick={() => deleteUser(user.id)} className="text-error text-label-sm hover:underline">Delete</button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
      </main>
    </div>
    {passwordUserId && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
        <div className="w-full max-w-sm rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-xl shadow-card">
          <h3 className="text-headline-sm text-primary mb-md">Set Password</h3>
          <div className="space-y-md">
            <input
              type="password"
              placeholder="Password mới (tối thiểu 6 ký tự)"
              value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
              className="w-full rounded-lg border border-outline-variant/30 bg-surface-container px-md py-sm outline-none"
            />
            {passwordError && <p className="text-label-sm text-error">{passwordError}</p>}
            <div className="flex gap-sm">
              <button onClick={savePassword} disabled={passwordSaving} className="flex-1 rounded-lg bg-secondary py-md text-label-md font-semibold text-on-secondary disabled:opacity-50">
                {passwordSaving ? 'Đang lưu...' : 'Lưu'}
              </button>
              <button onClick={() => setPasswordUserId(null)} className="rounded-lg border border-outline-variant/30 px-md py-md text-label-md text-on-surface-variant">
                Hủy
              </button>
            </div>
          </div>
        </div>
      </div>
    )}
    </RoleGate>
  )
}
