'use client'
import { useCallback, useEffect, useState } from 'react'
import type { HandoffCard, Me } from './types'
import { requestJson } from './model'
import { PreSendChecks } from './PreSendChecks'
import { ErrorBanner } from './ui'

/** The hub's warnings in full, read only for an order waiting to go to a supplier: the mapping check is too heavy for every task open. */
export default function TaskHandoffChecks({ orderId, me, onChanged }: { orderId: string; me: Me | null; onChanged: () => void }) {
  const [c, setCard] = useState<HandoffCard | null>(null)
  const [info, setInfo] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    const r = await requestJson<{ card: HandoffCard | null }>(`/api/design-studio/orders/${encodeURIComponent(orderId)}/handoff`)
    if (r.ok) setCard(r.data.card)
  }, [orderId])

  useEffect(() => { void load() }, [load])

  if (!c) return null
  return (
    <>
      {info && <span role="status" className="text-label-sm text-on-surface-variant">{info}</span>}
      <ErrorBanner msg={error} onClose={() => setError('')} />
      <PreSendChecks c={c} canHandoff={!!me?.canHandoff} onError={setError}
        onChanged={message => { setError(''); setInfo(message); void load(); onChanged() }} />
    </>
  )
}
