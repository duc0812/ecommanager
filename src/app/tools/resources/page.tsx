'use client'
import { KeyboardEvent, useEffect, useState } from 'react'
import Sidebar from '@/components/Sidebar'
import { RoleGate } from '@/components/RoleGate'

type Proxy = { id: string; name: string; host: string | null; port: string | null; username: string | null; password: string | null; provider: string | null; tags: string | null; purchaseDate: string | null; expireDate: string | null; status: string; note: string | null; accounts: Account[] }
type Account = { id: string; email: string; accountCode: string; accountType: string; status: string; proxyId: string | null; tags: string | null; note: string | null; proxy?: Proxy | null }
type TelegramStatus = { configured: boolean; botTokenMasked: string; chatId: string }

const emptyProxyForm = { name: '', host: '', port: '', username: '', password: '', provider: '', tags: '', purchaseDate: '', status: 'CANCEL' }
const emptyAccountForm = { email: '', accountCode: '', accountType: '', status: 'ACTIVE', proxyId: '', tags: '' }

export default function ResourcesPage() {
  const [proxies, setProxies] = useState<Proxy[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [proxyForm, setProxyForm] = useState(emptyProxyForm)
  const [accountForm, setAccountForm] = useState(emptyAccountForm)
  const [editingProxyId, setEditingProxyId] = useState<string | null>(null)
  const [editingAccountId, setEditingAccountId] = useState<string | null>(null)
  const [telegram, setTelegram] = useState<TelegramStatus | null>(null)
  const [telegramForm, setTelegramForm] = useState({ botToken: '', chatId: '' })
  const [telegramMessage, setTelegramMessage] = useState<string | null>(null)
  const [formMessage, setFormMessage] = useState<string | null>(null)

  async function load() {
    const data = await fetch('/api/tools/resources').then(r => r.json())
    setProxies(data.proxies ?? [])
    setAccounts(data.accounts ?? [])
    fetch('/api/tools/telegram').then(r => r.json()).then(setTelegram).catch(() => {})
  }

  useEffect(() => { load() }, [])

  async function saveProxy() {
    if (!proxyForm.host || !proxyForm.port) return
    const name = proxyForm.name || `${proxyForm.host}:${proxyForm.port}`
    setFormMessage(null)
    const res = await fetch('/api/tools/resources', {
      method: editingProxyId ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'proxy', id: editingProxyId, ...proxyForm, name }),
    })
    const json = await res.json()
    if (!res.ok) {
      setFormMessage(json.error || 'Could not save proxy')
      return
    }
    setProxyForm(emptyProxyForm)
    setEditingProxyId(null)
    await load()
  }

  async function saveAccount() {
    if (!accountForm.email || !accountForm.accountCode || !accountForm.accountType) return
    setFormMessage(null)
    const res = await fetch('/api/tools/resources', {
      method: editingAccountId ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'account', id: editingAccountId, ...accountForm }),
    })
    const json = await res.json()
    if (!res.ok) {
      setFormMessage(json.error || 'Could not save account')
      return
    }
    setAccountForm(emptyAccountForm)
    setEditingAccountId(null)
    await load()
  }

  async function updateProxy(id: string, status: string) {
    const proxy = proxies.find(p => p.id === id)
    if (!proxy) return
    await fetch('/api/tools/resources', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'proxy', ...proxy, id, status }) })
    await load()
  }

  async function updateAccount(id: string, status: string) {
    const account = accounts.find(a => a.id === id)
    if (!account) return
    await fetch('/api/tools/resources', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'account', ...account, id, status }) })
    await load()
  }

  function editProxy(proxy: Proxy) {
    setEditingProxyId(proxy.id)
    setProxyForm({
      name: proxy.name || '',
      host: proxy.host || '',
      port: proxy.port || '',
      username: proxy.username || '',
      password: proxy.password || '',
      provider: proxy.provider || '',
      tags: proxy.tags || '',
      purchaseDate: proxy.purchaseDate || '',
      status: proxy.status || 'CANCEL',
    })
  }

  function editAccount(account: Account) {
    setEditingAccountId(account.id)
    setAccountForm({
      email: account.email || '',
      accountCode: account.accountCode || '',
      accountType: account.accountType || '',
      status: account.status || 'ACTIVE',
      proxyId: account.proxyId || '',
      tags: account.tags || '',
    })
  }

  function cancelProxyEdit() {
    setEditingProxyId(null)
    setProxyForm(emptyProxyForm)
  }

  function cancelAccountEdit() {
    setEditingAccountId(null)
    setAccountForm(emptyAccountForm)
  }

  async function saveTelegram() {
    setTelegramMessage(null)
    const res = await fetch('/api/tools/telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(telegramForm),
    })
    const json = await res.json()
    if (!res.ok) {
      setTelegramMessage(json.error || 'Could not save Telegram settings')
      return
    }
    setTelegram(json.status)
    setTelegramForm({ botToken: '', chatId: '' })
    setTelegramMessage('Telegram settings saved.')
  }

  async function testTelegram() {
    setTelegramMessage(null)
    const res = await fetch('/api/tools/telegram', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Ecom Manager test: Telegram proxy alerts are connected.' }),
    })
    const json = await res.json()
    if (json.skipped) setTelegramMessage('Telegram is not configured.')
    else if (json.error) setTelegramMessage(`Telegram error: ${json.error}`)
    else setTelegramMessage('Test message sent.')
  }

  const maintain = proxies.filter(p => p.status === 'MAINTAIN')
  const cancel = proxies.filter(p => p.status === 'CANCEL')

  return (
    <RoleGate>
    <div className="flex min-h-screen bg-surface">
      <Sidebar />
      <main className="ml-[280px] flex-1 p-xl">
        <header className="mb-xl">
          <p className="text-label-sm uppercase tracking-wider text-on-surface-variant">Tools</p>
          <h2 className="text-display-md font-bold text-primary">Resource Management</h2>
          <p className="mt-xs text-body-md text-on-surface-variant">Proxy and account registry with automatic proxy cancellation status.</p>
        </header>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-xl">
          <section className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-lg">
            <h3 className="mb-md text-headline-sm text-primary">{editingProxyId ? 'Edit Proxy' : 'Add Proxy'}</h3>
            <div className="grid grid-cols-2 gap-md">
              <Input label="Proxy label (optional)" value={proxyForm.name} onChange={v => setProxyForm({ ...proxyForm, name: v })} />
              <Input label="Provider" value={proxyForm.provider} onChange={v => setProxyForm({ ...proxyForm, provider: v })} />
              <Input label="Host" value={proxyForm.host} onChange={v => setProxyForm({ ...proxyForm, host: v })} />
              <Input label="Port" value={proxyForm.port} onChange={v => setProxyForm({ ...proxyForm, port: v })} />
              <Input label="Username" value={proxyForm.username} onChange={v => setProxyForm({ ...proxyForm, username: v })} />
              <Input label="Password" value={proxyForm.password} onChange={v => setProxyForm({ ...proxyForm, password: v })} />
              <TagInput label="Proxy tags" placeholder="Type tag, press Enter" value={proxyForm.tags} onChange={v => setProxyForm({ ...proxyForm, tags: v })} />
              <Input label="Start date" type="date" value={proxyForm.purchaseDate} onChange={v => setProxyForm({ ...proxyForm, purchaseDate: v })} />
            </div>
            <div className="mt-md flex gap-sm">
              <button onClick={saveProxy} className="rounded-lg bg-secondary px-lg py-sm text-label-md text-on-secondary">{editingProxyId ? 'Update Proxy' : 'Save Proxy'}</button>
              {editingProxyId && <button onClick={cancelProxyEdit} className="rounded-lg bg-surface-container px-lg py-sm text-label-md text-on-surface-variant hover:bg-surface-container-high">Cancel Edit</button>}
            </div>
            {formMessage && <p className="mt-sm text-body-sm text-error">{formMessage}</p>}
          </section>

          <section className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-lg">
            <h3 className="mb-md text-headline-sm text-primary">{editingAccountId ? 'Edit Account' : 'Add Account'}</h3>
            <div className="grid grid-cols-2 gap-md">
              <Input label="Email" value={accountForm.email} onChange={v => setAccountForm({ ...accountForm, email: v })} />
              <Input label="Account code" value={accountForm.accountCode} onChange={v => setAccountForm({ ...accountForm, accountCode: v })} />
              <TagInput label="Account type" placeholder="Via, TikTokShop..." value={accountForm.accountType} onChange={v => setAccountForm({ ...accountForm, accountType: v })} single />
              <select value={accountForm.status} onChange={e => setAccountForm({ ...accountForm, status: e.target.value })} className="rounded-lg border border-outline-variant/30 bg-surface-container px-md py-sm">
                <option value="ACTIVE">Active</option>
                <option value="WARMING">Warming</option>
                <option value="DIE">Die</option>
              </select>
              <select value={accountForm.proxyId} onChange={e => setAccountForm({ ...accountForm, proxyId: e.target.value })} className="rounded-lg border border-outline-variant/30 bg-surface-container px-md py-sm">
                <option value="">No proxy</option>
                {proxies.map(p => <option key={p.id} value={p.id}>{p.name} - {p.status}</option>)}
              </select>
              <TagInput label="Account tags" placeholder="Type tag, press Enter" value={accountForm.tags} onChange={v => setAccountForm({ ...accountForm, tags: v })} />
            </div>
            <div className="mt-md flex gap-sm">
              <button onClick={saveAccount} className="rounded-lg bg-secondary px-lg py-sm text-label-md text-on-secondary">{editingAccountId ? 'Update Account' : 'Save Account'}</button>
              {editingAccountId && <button onClick={cancelAccountEdit} className="rounded-lg bg-surface-container px-lg py-sm text-label-md text-on-surface-variant hover:bg-surface-container-high">Cancel Edit</button>}
            </div>
          </section>
        </div>

        <section className="mt-xl rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-lg">
          <div className="mb-md flex items-center gap-sm">
            <span className="material-symbols-outlined text-secondary">notifications_active</span>
            <h3 className="text-headline-sm text-primary">Telegram Alerts</h3>
            <span className={`ml-auto rounded-full px-sm py-xs text-label-sm ${telegram?.configured ? 'bg-on-tertiary-container/15 text-on-tertiary-container' : 'bg-error/10 text-error'}`}>
              {telegram?.configured ? 'Configured' : 'Not configured'}
            </span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr_auto_auto] gap-md">
            <input
              type="password"
              value={telegramForm.botToken}
              onChange={e => setTelegramForm({ ...telegramForm, botToken: e.target.value })}
              placeholder={telegram?.botTokenMasked || 'Bot token'}
              className="rounded-lg border border-outline-variant/30 bg-surface-container px-md py-sm outline-none"
            />
            <input
              value={telegramForm.chatId}
              onChange={e => setTelegramForm({ ...telegramForm, chatId: e.target.value })}
              placeholder={telegram?.chatId || 'Chat ID'}
              className="rounded-lg border border-outline-variant/30 bg-surface-container px-md py-sm outline-none"
            />
            <button onClick={saveTelegram} className="rounded-lg bg-secondary px-lg py-sm text-label-md text-on-secondary">Save</button>
            <button onClick={testTelegram} className="rounded-lg bg-surface-container px-lg py-sm text-label-md text-on-surface-variant hover:bg-surface-container-high">Test</button>
          </div>
          {telegramMessage && <p className="mt-sm text-body-sm text-on-surface-variant">{telegramMessage}</p>}
        </section>

        <div className="mt-xl grid grid-cols-1 md:grid-cols-3 gap-lg">
          <Stat title="Maintain proxies" value={String(maintain.length)} />
          <Stat title="Cancel proxies" value={String(cancel.length)} />
          <Stat title="Active accounts" value={String(accounts.filter(a => a.status === 'ACTIVE').length)} />
        </div>

        <section className="mt-xl rounded-xl border border-outline-variant/20 bg-surface-container-lowest overflow-hidden">
          <div className="border-b border-outline-variant/20 px-lg py-md"><h3 className="text-headline-sm text-primary">Proxy Register</h3></div>
          <table className="w-full">
            <thead><tr className="bg-surface-container-low/40 text-left">{['Proxy', 'Tags', 'Start Date', 'Accounts', 'Status', 'Action'].map(h => <th key={h} className="px-lg py-sm text-label-sm uppercase tracking-wider text-on-surface-variant">{h}</th>)}</tr></thead>
            <tbody className="divide-y divide-outline-variant/10">
              {proxies.map(proxy => (
                <tr key={proxy.id}>
                  <td className="px-lg py-md"><p className="text-label-md text-primary">{proxy.name}</p><p className="text-label-sm text-on-surface-variant">{formatProxy(proxy)}</p></td>
                  <td className="px-lg py-md text-body-sm">{proxy.tags || '-'}</td>
                  <td className="px-lg py-md text-body-sm text-on-surface-variant">{proxy.purchaseDate || '-'}</td>
                  <td className="px-lg py-md text-body-sm">{proxy.accounts.filter(a => a.status === 'ACTIVE').length} active</td>
                  <td className="px-lg py-md"><Badge status={proxy.status} /></td>
                  <td className="px-lg py-md">
                    <button onClick={() => editProxy(proxy)} className="mr-md text-secondary text-label-sm hover:underline">Edit</button>
                    <button onClick={() => updateProxy(proxy.id, proxy.status === 'CANCEL' ? 'MAINTAIN' : 'CANCEL')} className="text-secondary text-label-sm hover:underline">
                      {proxy.status === 'CANCEL' ? 'Maintain' : 'Cancel'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="mt-xl rounded-xl border border-outline-variant/20 bg-surface-container-lowest overflow-hidden">
          <div className="border-b border-outline-variant/20 px-lg py-md"><h3 className="text-headline-sm text-primary">Account Register</h3></div>
          <table className="w-full">
            <thead><tr className="bg-surface-container-low/40 text-left">{['Email', 'Code', 'Type', 'Proxy', 'Status', 'Action'].map(h => <th key={h} className="px-lg py-sm text-label-sm uppercase tracking-wider text-on-surface-variant">{h}</th>)}</tr></thead>
            <tbody className="divide-y divide-outline-variant/10">
              {accounts.map(account => (
                <tr key={account.id}>
                  <td className="px-lg py-md text-body-sm">{account.email}</td>
                  <td className="px-lg py-md text-body-sm">{account.accountCode}</td>
                  <td className="px-lg py-md text-body-sm">{account.accountType}</td>
                  <td className="px-lg py-md text-body-sm">{account.proxy?.name || '-'}</td>
                  <td className="px-lg py-md"><Badge status={account.status} /></td>
                  <td className="px-lg py-md">
                    <button onClick={() => editAccount(account)} className="mr-md text-secondary text-label-sm hover:underline">Edit</button>
                    <button onClick={() => updateAccount(account.id, account.status === 'DIE' ? 'ACTIVE' : 'DIE')} className="text-secondary text-label-sm hover:underline">
                      {account.status === 'DIE' ? 'Restore' : 'Mark die'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </main>
    </div>
    </RoleGate>
  )
}

function formatProxy(proxy: Proxy) {
  const hostPort = [proxy.host, proxy.port].filter(Boolean).join(':') || '-'
  const auth = proxy.username || proxy.password ? `${proxy.username || ''}:${proxy.password || ''}` : ''
  return auth ? `${hostPort}:${auth}` : hostPort
}

function Input({ label, value, onChange, type = 'text' }: { label: string; value: string; onChange: (value: string) => void; type?: string }) {
  return <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={label} className="rounded-lg border border-outline-variant/30 bg-surface-container px-md py-sm outline-none" />
}

function TagInput({ label, placeholder, value, onChange, single = false }: { label: string; placeholder: string; value: string; onChange: (value: string) => void; single?: boolean }) {
  const [draft, setDraft] = useState('')
  const tags = value.split(',').map(t => t.trim()).filter(Boolean)

  function commit(raw = draft) {
    const nextTags = raw.split(',').map(t => t.trim()).filter(Boolean)
    if (nextTags.length === 0) return
    const merged = single ? [nextTags[0]] : Array.from(new Set([...tags, ...nextTags]))
    onChange(merged.join(','))
    setDraft('')
  }

  function remove(tag: string) {
    onChange(tags.filter(t => t !== tag).join(','))
  }

  function keyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      commit()
    }
    if (e.key === 'Backspace' && !draft && tags.length > 0) {
      remove(tags[tags.length - 1])
    }
  }

  return (
    <div className="min-h-[42px] rounded-lg border border-outline-variant/30 bg-surface-container px-sm py-xs">
      <div className="flex flex-wrap items-center gap-xs">
        {tags.map(tag => (
          <span key={tag} className="inline-flex items-center gap-xs rounded-full bg-secondary/10 px-sm py-xs text-label-sm text-secondary">
            {tag}
            <button type="button" onClick={() => remove(tag)} className="text-secondary/70 hover:text-secondary">
              <span className="material-symbols-outlined text-[12px]">close</span>
            </button>
          </span>
        ))}
        <input
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={() => commit()}
          onKeyDown={keyDown}
          placeholder={tags.length === 0 ? placeholder || label : ''}
          className="min-w-[140px] flex-1 bg-transparent px-xs py-xs text-body-sm outline-none"
        />
      </div>
    </div>
  )
}

function Stat({ title, value }: { title: string; value: string }) {
  return <div className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-lg"><p className="text-label-sm uppercase tracking-wider text-on-surface-variant">{title}</p><p className="mt-xs text-stats-lg text-primary">{value}</p></div>
}

function Badge({ status }: { status: string }) {
  const cls = status === 'CANCEL' || status === 'DIE' ? 'bg-error/10 text-error' : 'bg-on-tertiary-container/15 text-on-tertiary-container'
  return <span className={`${cls} rounded-full px-sm py-xs text-label-sm`}>{status}</span>
}
