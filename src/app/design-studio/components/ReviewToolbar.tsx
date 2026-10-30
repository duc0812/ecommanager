'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Me, ReviewCard } from './types'
import { postJson, requestJson, taskUrl } from './model'
import { machineQa } from './ai-qa'
import { reviewVerdict } from './review-check'
import { useToast } from './overlay'
import { Icon, btn, card } from './ui'

type ReviewResponse = { cards: ReviewCard[]; me: Me }

/** The row above the review workspace: how many wait, and one button for the ones the machine finds nothing wrong with. */
export default function ReviewToolbar({ total, version, onApproved }: { total: number; version: number; onApproved: (keys: string[]) => void }) {
  const toast = useToast()
  const [cards, setCards] = useState<ReviewCard[]>([])
  const [me, setMe] = useState<Me | null>(null)
  const [batch, setBatch] = useState<{ done: number; total: number } | null>(null)

  const load = useCallback(async () => {
    const r = await requestJson<ReviewResponse>('/api/design-studio/tasks/review')
    if (!r.ok) return
    setCards(r.data.cards)
    setMe(r.data.me)
  }, [])
  useEffect(() => { load() }, [load, version])

  const clean = useMemo(() => {
    if (!me) return []
    return cards.filter(c => {
      const d = { task: c.task, line: c.line, template: c.template ?? null, slots: c.slots, library: c.library ?? null, profile: c.profile ?? null, me }
      return reviewVerdict(d, machineQa(d)).status === 'ok'
    }).map(c => c.task.taskKey)
  }, [cards, me])

  async function approveClean() {
    if (batch || clean.length === 0) return
    if (!window.confirm(`Duyệt ${clean.length} mẫu máy không thấy lỗi (đủ file, đúng khổ, có mockup)?\n${clean.join(', ')}`)) return
    setBatch({ done: 0, total: clean.length })
    const ok: string[] = []
    const failed: string[] = []
    for (const key of clean) {
      const r = await postJson(taskUrl(key, '/transition'), { to: 'DONE' })
      if (r.ok) ok.push(key); else failed.push(`${key}: ${r.error}`)
      setBatch({ done: ok.length + failed.length, total: clean.length })
    }
    setBatch(null)
    if (ok.length) toast.say(`Đã duyệt ${ok.length} mẫu`)
    if (failed.length) toast.say(`Không duyệt được ${failed.length}: ${failed.join(' · ')}`, 'bad')
    onApproved(ok)
    load()
  }

  return (
    <div className={`${card} px-md py-sm flex items-center gap-sm flex-wrap`}>
      <Icon name="fact_check" className="text-secondary text-[20px]" />
      <span className="text-body-md font-semibold text-on-surface">Duyệt mẫu</span>
      <span className="text-label-sm text-on-surface-variant">{total} mẫu chờ duyệt{clean.length ? ` · ${clean.length} máy không thấy lỗi` : ''}</span>
      {me?.canApprove && clean.length > 0 && (
        <button type="button" className={`${btn} ml-auto`} disabled={!!batch} onClick={approveClean}>
          <Icon name="done_all" className="text-[16px]" />
          {batch ? `Đang duyệt ${batch.done}/${batch.total}…` : `Duyệt nhanh ${clean.length} mẫu máy không thấy lỗi`}
        </button>
      )}
    </div>
  )
}
