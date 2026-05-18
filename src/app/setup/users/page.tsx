'use client'
import { useEffect, useState } from 'react'
import Sidebar from '@/components/Sidebar'
import { RoleGate } from '@/components/RoleGate'
import { ROLE_LABELS, UserRole } from '@/lib/roles'

type AppUser = { id: string; name: string; email: string; role: UserRole; status: string; createdAt: string }

export default function UsersPage() {
  const [users, setUsers] = useState<AppUser[]>([])
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<UserRole>('SELLER')
  const [saving, setSaving] = useState(false)

  async function load() {
    setUsers(await fetch('/api/users').then(r => r.json()))
  }

  useEffect(() => { load() }, [])

  async function createUser() {
    if (!name || !email) return
    setSaving(true)
    await fetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, role }),
    })
    setName('')
    setEmail('')
    setRole('SELLER')
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
          <p className="mt-xs text-body-md text-on-surface-variant">Super Admin manages users. Admin can view all data but cannot access setup.</p>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-xl">
          <section className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-lg">
            <h3 className="text-headline-sm text-primary mb-md">Add User</h3>
            <div className="space-y-md">
              <input value={name} onChange={e => setName(e.target.value)} placeholder="Name" className="w-full rounded-lg border border-outline-variant/30 bg-surface-container px-md py-sm outline-none" />
              <input value={email} onChange={e => setEmail(e.target.value)} placeholder="Email" className="w-full rounded-lg border border-outline-variant/30 bg-surface-container px-md py-sm outline-none" />
              <select value={role} onChange={e => setRole(e.target.value as UserRole)} className="w-full rounded-lg border border-outline-variant/30 bg-surface-container px-md py-sm outline-none">
                <option value="ADMIN">Admin</option>
                <option value="SELLER">Seller</option>
                <option value="SUPPORT">Support</option>
              </select>
              <button onClick={createUser} disabled={saving || !name || !email} className="w-full rounded-lg bg-secondary py-md text-label-md font-semibold text-on-secondary disabled:opacity-50">
                {saving ? 'Saving...' : 'Save User'}
              </button>
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
                    <td className="px-lg py-md text-body-sm text-on-surface-variant">
                      {user.role === 'SUPERADMIN' && 'All data + setup'}
                      {user.role === 'ADMIN' && 'All data, no setup'}
                      {user.role === 'SELLER' && 'Project Management only'}
                      {user.role === 'SUPPORT' && 'Fulfillment + Other Bills'}
                    </td>
                    <td className="px-lg py-md"><span className="rounded-full bg-on-tertiary-container/15 px-sm py-xs text-label-sm text-on-tertiary-container">{user.status}</span></td>
                    <td className="px-lg py-md">
                      {user.role !== 'SUPERADMIN' && <button onClick={() => deleteUser(user.id)} className="text-error text-label-sm hover:underline">Delete</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
      </main>
    </div>
    </RoleGate>
  )
}
