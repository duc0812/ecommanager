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
  isUserRole,
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
  storeIds: string[]
  skuPrefix: string | null
}

type StoreOption = { id: string; name: string; shop: string; enabled: boolean }

export default function UsersPage() {
  const [users, setUsers] = useState<AppUser[]>([])
  const [stores, setStores] = useState<StoreOption[]>([])
  const [storeIds, setStoreIds] = useState<string[]>([])
  const [saveError, setSaveError] = useState('')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<UserRole>('SELLER')
  const [skuPrefix, setSkuPrefix] = useState('')
  const [permissions, setPermissions] = useState<FeaturePermission[]>(DEFAULT_ROLE_PERMISSIONS.SELLER)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [passwordUserId, setPasswordUserId] = useState<string | null>(null)
  const [newPassword, setNewPassword] = useState('')
  const [passwordSaving, setPasswordSaving] = useState(false)
  const [passwordError, setPasswordError] = useState('')
  const [skuDrafts, setSkuDrafts] = useState<Record<string, string>>({})
  const [skuErrors, setSkuErrors] = useState<Record<string, string>>({})
  const [skuSavingId, setSkuSavingId] = useState<string | null>(null)

  async function savePassword() {
    if (!passwordUserId || newPassword.length < 10) {
      setPasswordError('Password phải có ít nhất 10 ký tự')
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

  // The Super Admin row cannot go through the form (POST refuses that account), so its SKU letters are saved with PATCH.
  async function saveOwnSkuPrefix(user: AppUser) {
    setSkuSavingId(user.id)
    setSkuErrors(current => ({ ...current, [user.id]: '' }))
    const res = await fetch(`/api/users/${user.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skuPrefix: (skuDrafts[user.id] ?? '').trim() }),
    })
    if (res.ok) {
      setSkuDrafts(current => {
        const next = { ...current }
        delete next[user.id]
        return next
      })
      await load()
    } else {
      const data = await res.json().catch(() => ({}))
      setSkuErrors(current => ({ ...current, [user.id]: data.error || 'Không lưu được mã SKU' }))
    }
    setSkuSavingId(null)
  }

  async function load() {
    setUsers(await fetch('/api/users').then(r => r.json()))
  }

  useEffect(() => { load() }, [])

  useEffect(() => {
    fetch('/api/stores?includeDisabled=1').then(r => r.json()).then(d => setStores(Array.isArray(d.stores) ? d.stores : [])).catch(() => {})
  }, [])

  function changeRole(next: UserRole) {
    setRole(next)
    setPermissions(DEFAULT_ROLE_PERMISSIONS[next])
  }

  // Only a store that is switched on can be given; one the seller already has stays in the list, ticked, until it is unticked.
  const pickable = stores.filter(store => store.enabled || storeIds.includes(store.id))

  function toggleStore(id: string) {
    setStoreIds(current => (current.includes(id) ? current.filter(item => item !== id) : [...current, id]))
  }

  function storesLabel(user: AppUser) {
    if (!isUserRole(user.role)) return 'Không có store'
    if (user.role !== 'SELLER') return 'Tất cả store'
    const names = user.storeIds.flatMap(id => {
      const store = stores.find(s => s.id === id)
      return store ? [store.enabled ? store.name : `${store.name} (đã tắt)`] : []
    })
    return names.length > 0 ? names.join(', ') : 'Chưa giao store'
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
    setStoreIds(user.storeIds ?? [])
    setSkuPrefix(user.skuPrefix ?? '')
    setSaveError('')
  }

  function resetForm() {
    setEditingId(null)
    setName('')
    setEmail('')
    setRole('SELLER')
    setPermissions(DEFAULT_ROLE_PERMISSIONS.SELLER)
    setStoreIds([])
    setSkuPrefix('')
    setSaveError('')
  }

  async function saveUser() {
    if (!name || !email) return
    setSaving(true)
    setSaveError('')
    const res = await fetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, role, permissions, skuPrefix: skuPrefix.trim(), ...(role === 'SELLER' ? { storeIds } : {}) }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      setSaveError(data.error || 'Không lưu được user')
      setSaving(false)
      return
    }
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
      <main className="ml-0 lg:ml-[280px] mt-14 lg:mt-0 flex-1 p-xl">
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
              <input value={skuPrefix} onChange={e => setSkuPrefix(e.target.value.toUpperCase())} maxLength={2} placeholder="Mã SKU (2 chữ cái)" className="w-full rounded-lg border border-outline-variant/30 bg-surface-container px-md py-sm outline-none" />
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
              {role === 'SELLER' && (
                <div className="space-y-sm rounded-lg border border-outline-variant/20 bg-surface-container-low p-md">
                  <p className="text-label-md font-semibold text-primary">Store được xem</p>
                  {pickable.length === 0 ? (
                    <p className="text-body-sm text-on-surface-variant">Chưa có store nào.</p>
                  ) : (
                    <div className="space-y-xs">
                      {pickable.map(store => (
                        <label key={store.id} className="flex cursor-pointer items-center gap-sm text-body-sm">
                          <input
                            type="checkbox"
                            checked={storeIds.includes(store.id)}
                            onChange={() => toggleStore(store.id)}
                            className="h-4 w-4 accent-secondary"
                          />
                          <span>{store.name}</span>
                          <span className="text-label-sm text-on-surface-variant">{store.shop}</span>
                          {!store.enabled && <span className="rounded-full bg-surface-container-high px-sm py-[1px] text-label-sm text-on-surface-variant">đã tắt</span>}
                        </label>
                      ))}
                    </div>
                  )}
                  {storeIds.length === 0 && (
                    <p className="text-label-sm text-amber-700">Chưa chọn store nào: seller này sẽ không thấy dữ liệu của store nào.</p>
                  )}
                </div>
              )}
              {saveError && <p className="text-label-sm text-error">{saveError}</p>}
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
                  {['User', 'Role', 'Access', 'Store', 'Mã SKU', 'Status', ''].map(h => <th key={h} className="px-lg py-sm text-label-sm uppercase tracking-wider text-on-surface-variant">{h}</th>)}
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
                    <td className="max-w-[220px] px-lg py-md text-body-sm text-on-surface-variant">{storesLabel(user)}</td>
                    <td className="px-lg py-md text-body-sm font-mono text-primary">
                      {user.role === 'SUPERADMIN' ? (
                        <div className="space-y-xs">
                          <div className="flex items-center gap-sm">
                            <input
                              value={skuDrafts[user.id] ?? user.skuPrefix ?? ''}
                              onChange={e => setSkuDrafts(current => ({ ...current, [user.id]: e.target.value.toUpperCase() }))}
                              maxLength={2}
                              placeholder="Mã SKU"
                              aria-label="Mã SKU (2 chữ cái)"
                              className="w-20 rounded-lg border border-outline-variant/30 bg-surface-container px-sm py-xs outline-none"
                            />
                            <button
                              onClick={() => saveOwnSkuPrefix(user)}
                              disabled={skuSavingId === user.id || skuDrafts[user.id] === undefined || skuDrafts[user.id] === (user.skuPrefix ?? '')}
                              className="text-secondary text-label-sm hover:underline disabled:opacity-50 disabled:no-underline"
                            >
                              {skuSavingId === user.id ? 'Đang lưu...' : 'Lưu'}
                            </button>
                          </div>
                          {skuErrors[user.id] && <p className="font-sans text-label-sm text-error">{skuErrors[user.id]}</p>}
                        </div>
                      ) : (user.skuPrefix ?? '—')}
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
