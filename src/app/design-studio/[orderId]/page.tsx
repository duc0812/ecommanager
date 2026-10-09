'use client'
import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Sidebar from '@/components/Sidebar'
import { requestJson } from '../components/model'
import type { TaskRow } from '../components/types'

const ALL_STATUSES = 'NEW,ASSIGNED,DOING,REVIEW,REJECTED,ASK_CUSTOMER,DONE,CANCELLED'

export default function OrderRedirectPage() {
  const params = useParams<{ orderId: string }>()
  const router = useRouter()
  const orderId = decodeURIComponent(params.orderId)
  const [msg, setMsg] = useState('Đang mở task của đơn…')

  useEffect(() => {
    let alive = true
    ;(async () => {
      const ws = await requestJson<{ order: { id: string; shopifyOrderNumber: string } }>(`/api/design-studio/orders/${encodeURIComponent(orderId)}`)
      const number = ws.ok ? ws.data.order.shopifyOrderNumber.replace(/^#/, '') : orderId.replace(/^#/, '')
      const r = await requestJson<{ tasks: TaskRow[] }>(`/api/design-studio/tasks?statuses=${ALL_STATUSES}&q=${encodeURIComponent(number)}`)
      if (!alive) return
      const tasks = r.ok ? r.data.tasks : []
      const mine = tasks
        .filter(t => (ws.ok ? t.orderId === ws.data.order.id : t.orderNumber.replace(/^#/, '') === number) && t.status !== 'CANCELLED')
        .sort((a, b) => a.linePosition - b.linePosition)
      if (mine[0]) router.replace(`/design-studio?task=${encodeURIComponent(mine[0].taskKey)}`)
      else { setMsg('Đơn này chưa có task — mở danh sách'); router.replace('/design-studio') }
    })()
    return () => { alive = false }
  }, [orderId, router])

  return (
    <div className="flex min-h-screen bg-surface">
      <Sidebar />
      <main className="ml-[280px] flex-1 p-xl">
        <div className="text-body-sm text-on-surface-variant">{msg}</div>
      </main>
    </div>
  )
}
