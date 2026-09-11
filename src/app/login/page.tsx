'use client'
import { Suspense, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

function safeNext(value: string | null) {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/login')) return '/'
  return value
}

function LoginForm() {
  const router = useRouter()
  const params = useSearchParams()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (loading) return
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      if (res.ok) {
        const data = await res.json().catch(() => ({}))
        const next = params.get('next')
        router.push(next ? safeNext(next) : (typeof data.home === 'string' ? data.home : '/'))
        router.refresh()
        return
      }
      const data = await res.json().catch(() => ({}))
      setError(data.error || 'Email hoặc password không đúng')
    } catch {
      setError('Không kết nối được server')
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-md">
      <input
        type="email"
        placeholder="Email"
        value={email}
        onChange={e => setEmail(e.target.value)}
        required
        autoComplete="username"
        className="w-full rounded-lg border border-outline-variant/30 bg-surface-container px-md py-sm outline-none focus:border-secondary"
      />
      <input
        type="password"
        placeholder="Password"
        value={password}
        onChange={e => setPassword(e.target.value)}
        required
        autoComplete="current-password"
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
  )
}

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-surface">
      <div className="w-full max-w-sm rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-xl shadow-card">
        <h1 className="text-headline-md font-bold text-primary mb-xs">Ecom Manager</h1>
        <p className="text-body-sm text-on-surface-variant mb-xl">Đăng nhập để tiếp tục</p>
        <Suspense fallback={null}>
          <LoginForm />
        </Suspense>
      </div>
    </div>
  )
}
