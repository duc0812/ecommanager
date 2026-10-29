'use client'
import { useState } from 'react'
import { postJson } from './model'
import { useToast } from './overlay'

/** Re-reads the order's lines from Shopify (custom fields, preview, variant image). */
export function useShopifyRefresh(orderId: string, onChanged: () => void) {
  const toast = useToast()
  const [refreshing, setRefreshing] = useState(false)
  async function refresh() {
    if (refreshing) return
    setRefreshing(true)
    const r = await postJson(`/api/design-studio/orders/${encodeURIComponent(orderId)}/refresh`, {})
    setRefreshing(false)
    if (!r.ok) { toast.say(r.error, 'bad'); return }
    const { updated = 0, unmatched = 0 } = r.data ?? {}
    toast.say(`Đã nạp lại ${updated} dòng từ Shopify${unmatched ? `, ${unmatched} dòng không khớp` : ''}`)
    onChanged()
  }
  return { refreshing, refresh }
}
