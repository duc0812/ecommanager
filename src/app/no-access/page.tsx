'use client'
import Link from 'next/link'

export default function NoAccessPage() {
  return (
    <div className="flex min-h-screen bg-surface">
      <main className="m-auto max-w-md rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-xl text-center">
        <span className="material-symbols-outlined text-[48px] text-error">lock</span>
        <h2 className="mt-md text-headline-sm text-primary">No Access</h2>
        <p className="mt-sm text-body-sm text-on-surface-variant">Tài khoản của bạn không có quyền truy cập trang này.</p>
        <Link href="/" className="mt-lg inline-block rounded-lg bg-secondary px-lg py-sm text-label-md text-on-secondary">Về trang chủ</Link>
      </main>
    </div>
  )
}
