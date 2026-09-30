'use client'
import { useCallback, useEffect, useState } from 'react'

type StepResult = Record<string, any> | null

type DailySync = {
  schedule: { cron: string; timezone: string; label: string }
  running: boolean
  last: {
    startedAt: string
    finishedAt: string
    ok: boolean
    steps: { payouts: StepResult; billing: StepResult; reserve: StepResult }
  } | null
}

const STEP_LABELS: Record<string, string> = {
  payouts: 'Shopify payouts + balance',
  billing: 'Meta billing',
  reserve: 'Dự phòng Meta',
}

function stepSummary(name: string, value: StepResult): { text: string; failed: boolean } {
  if (!value) return { text: 'chưa chạy', failed: false }
  if (typeof value.error === 'string') return { text: value.error, failed: true }
  if (value.skipped) return { text: String(value.reason ?? 'bỏ qua'), failed: false }
  if (name === 'payouts') return { text: `${value.synced_payouts ?? 0} payout`, failed: false }
  if (name === 'billing') {
    const synced = value.totals?.synced ?? 0
    const errors = Array.isArray(value.accountErrors) ? value.accountErrors.length : 0
    const timedOut = value.timedOut ? ', quá thời gian chờ' : ''
    return {
      text: `${value.status}, ${synced} billing${errors > 0 ? `, ${errors} account lỗi` : ''}${timedOut}`,
      failed: value.status === 'FAILED' || errors > 0 || Boolean(value.timedOut),
    }
  }
  if (name === 'reserve') {
    const refreshed = Array.isArray(value.refreshed) ? value.refreshed.length : 0
    const errors = Array.isArray(value.errors) ? value.errors.length : 0
    return { text: `${refreshed} account${errors > 0 ? `, ${errors} lỗi` : ''}`, failed: errors > 0 }
  }
  return { text: 'xong', failed: false }
}

export default function DailySyncStatus() {
  const [data, setData] = useState<DailySync | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/sync/daily')
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Không đọc được trạng thái sync')
      setData(json)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Không đọc được trạng thái sync')
    }
  }, [])

  useEffect(() => { load() }, [load])

  const runNow = async () => {
    setRunning(true)
    setError(null)
    try {
      const res = await fetch('/api/sync/daily', { method: 'POST' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Không chạy được sync')
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Không chạy được sync')
    } finally {
      setRunning(false)
    }
  }

  const last = data?.last ?? null
  const failed = last ? !last.ok : false

  return (
    <div className="mb-lg bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20">
      <div className="flex items-center gap-sm px-lg py-md flex-wrap">
        <span className={`material-symbols-outlined text-[20px] ${failed ? 'text-error' : 'text-secondary'}`}>schedule</span>
        <div>
          <h3 className="text-title-sm font-semibold text-on-surface">
            Sync tự động {data?.schedule.label ?? '15:00 giờ Việt Nam'}
          </h3>
          <p className="text-label-sm text-on-surface-variant">
            {last
              ? `Lần cuối: ${new Date(last.finishedAt).toLocaleString('en-US')}`
              : 'Chưa có lần chạy nào được ghi lại'}
          </p>
        </div>

        <div className="ml-auto flex items-center gap-md flex-wrap">
          {last && (
            <div className="flex gap-md flex-wrap">
              {(['payouts', 'billing', 'reserve'] as const).map(name => {
                const summary = stepSummary(name, last.steps[name])
                return (
                  <div key={name} className="text-label-sm">
                    <p className="text-on-surface-variant">{STEP_LABELS[name]}</p>
                    <p className={summary.failed ? 'text-error font-semibold' : 'text-on-surface'}>{summary.text}</p>
                  </div>
                )
              })}
            </div>
          )}
          <button
            onClick={runNow}
            disabled={running || data?.running}
            className="flex items-center gap-xs bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md hover:opacity-90 disabled:opacity-50"
          >
            <span className={`material-symbols-outlined text-[18px] ${running || data?.running ? 'animate-spin' : ''}`}>sync</span>
            {running || data?.running ? 'Đang chạy...' : 'Chạy ngay'}
          </button>
        </div>
      </div>

      {error && (
        <p className="mx-lg mb-md flex items-start gap-sm rounded-lg border border-error/20 bg-error-container/20 px-md py-sm text-body-sm text-error">
          <span className="material-symbols-outlined text-[18px]">error</span>
          {error}
        </p>
      )}
    </div>
  )
}
