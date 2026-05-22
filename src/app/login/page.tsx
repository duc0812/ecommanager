'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    if (res.ok) {
      router.push('/')
      router.refresh()
    } else {
      const data = await res.json()
      setError(data.error || 'Email hoặc password không đúng')
    }
    setLoading(false)
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface">
      <div className="w-full max-w-sm rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-xl shadow-card">
        <h1 className="text-headline-md font-bold text-primary mb-xs">Ecom Manager</h1>
        <p className="text-body-sm text-on-surface-variant mb-xl">Đăng nhập để tiếp tục</p>

        <form onSubmit={handleSubmit} className="space-y-md">
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            className="w-full rounded-lg border border-outline-variant/30 bg-surface-container px-md py-sm outline-none focus:border-secondary"
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            className="w-full rounded-lg border border-outline-variant/30 bg-surface-container px-md py-sm outline-none focus:border-secondary"
          />
          {error && <p className="text-label-sm text-error">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-secondary py-md text-label-md font-semibold text-on-secondary disabled:opacity-50"
          >
            {loading ? 'Đang đăng nhập...' : 'Đăng nhập'}
          </button>
        </form>
      </div>
    </div>
  )
}
