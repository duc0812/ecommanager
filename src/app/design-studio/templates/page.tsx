'use client'
import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Sidebar from '@/components/Sidebar'

export default function PrintTemplatesRedirect() {
  const router = useRouter()
  useEffect(() => {
    const supplierId = new URLSearchParams(window.location.search).get('supplierId')
    router.replace(supplierId ? `/fulfillment/suppliers/${encodeURIComponent(supplierId)}/print-templates` : '/fulfillment/suppliers')
  }, [router])
  return (
    <div className="flex min-h-screen bg-surface">
      <Sidebar />
      <main className="ml-[280px] flex-1 p-xl">
        <p className="text-body-sm text-on-surface-variant">Print templates nay nằm trong trang từng xưởng — đang chuyển…</p>
      </main>
    </div>
  )
}
