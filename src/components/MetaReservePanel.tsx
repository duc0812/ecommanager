'use client'
import { useCallback, useEffect, useState } from 'react'

type ReserveLevel = 'OK' | 'WATCH' | 'URGENT' | 'UNKNOWN'

type ReserveAccount = {
  id: string
  accountId: string
  accountName: string | null
  currency: string
  balance: number | null
  balanceSyncedAt: string | null
  budgetRemaining: number | null
  plannedDailySpend: number | null
  spendToday: number | null
  activeCampaignCount: number | null
  accountStatus: number | null
  threshold: number | null
  thresholdSource: 'MANUAL' | 'INFERRED' | null
  thresholdOccurrences: number | null
  thresholdLastSeen: string | null
  fundingCardLast4: string | null
  excluded: boolean
  projectedBalance: number | null
  headroom: number | null
  daysToCharge: number | null
  chargeAmount: number | null
  willCross: boolean
  staleDays: number | null
  level: ReserveLevel
  reasons: string[]
}

type ReserveCard = {
  cardLast4: string | null
  level: ReserveLevel
  accountIds: string[]
  totals: { currency: string; amount: number }[]
  totalUsd: number | null
}

type ReserveOverview = {
  accounts: ReserveAccount[]
  cards: ReserveCard[]
  totalReserveUsd: number
  horizonDays: number
  today: string
  generatedAt: string
  refresh?: { refreshed: string[]; errors: { accountId: string; message: string }[] }
}

const HORIZONS = [1, 3, 7]

const REASON_LABELS: Record<string, string> = {
  UNSETTLED: 'Meta chưa thu được tiền',
  ALREADY_OVER: 'Đã vượt ngưỡng',
  WILL_CROSS: 'Budget còn lại sẽ vượt ngưỡng',
  DUE_SOON: 'Sắp tới ngưỡng',
  NO_THRESHOLD: 'Chưa có ngưỡng',
  NO_BALANCE: 'Chưa sync balance',
  NO_ACTIVE_SPEND: 'Không có campaign đang chạy',
  STALE_DATA: 'Dữ liệu cũ',
}

const LEVEL_STYLE: Record<ReserveLevel, string> = {
  URGENT: 'bg-error/15 text-error',
  WATCH: 'bg-amber-100 text-amber-900',
  OK: 'bg-on-tertiary-container/15 text-on-tertiary-container',
  UNKNOWN: 'bg-surface-container text-on-surface-variant',
}

const LEVEL_LABEL: Record<ReserveLevel, string> = {
  URGENT: 'Cần nạp ngay',
  WATCH: 'Theo dõi',
  OK: 'Ổn',
  UNKNOWN: 'Chưa đủ dữ liệu',
}

function fmtMoney(amount: number | null, currency: string) {
  if (amount === null || amount === undefined) return '—'
  try {
    return new Intl.NumberFormat(currency === 'VND' ? 'vi-VN' : 'en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: currency === 'VND' ? 0 : 2,
    }).format(amount)
  } catch {
    return `${amount.toLocaleString()} ${currency}`
  }
}

function fmtUsd(amount: number | null) {
  if (amount === null) return '—'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount)
}

function fmtDays(days: number | null) {
  if (days === null) return '—'
  if (days <= 0) return 'hôm nay'
  if (days < 1) return 'trong hôm nay'
  return `~${days.toFixed(1)} ngày`
}

function formulaHint(row: ReserveAccount) {
  if (row.balance === null) return 'chưa sync balance'
  const balance = fmtMoney(row.balance, row.currency)
  const remaining = fmtMoney(row.budgetRemaining ?? 0, row.currency)
  return `${balance} + ${remaining}`
}

function fmtDate(value: string | null) {
  if (!value) return '—'
  return new Date(value.length === 10 ? `${value}T00:00:00` : value).toLocaleDateString('en-US')
}

export default function MetaReservePanel() {
  const [data, setData] = useState<ReserveOverview | null>(null)
  const [horizon, setHorizon] = useState(3)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [open, setOpen] = useState(true)

  const load = useCallback(async (days: number) => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/meta/reserve?horizon=${days}`)
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Không tải được dữ liệu dự phòng')
      setData(json)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Không tải được dữ liệu dự phòng')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load(horizon) }, [load, horizon])

  const refresh = async () => {
    setRefreshing(true)
    setError(null)
    try {
      const res = await fetch(`/api/meta/reserve?horizon=${horizon}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Không làm mới được')
      setData(json)
      if (json.refresh?.errors?.length) {
        setError(json.refresh.errors.map((e: any) => `${e.accountId}: ${e.message}`).join(' · '))
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Không làm mới được')
    } finally {
      setRefreshing(false)
    }
  }

  const toggleExcluded = async (id: string, excluded: boolean) => {
    setError(null)
    const res = await fetch('/api/meta/reserve', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, excludedFromCashflow: excluded }),
    })
    if (!res.ok) {
      const json = await res.json().catch(() => ({}))
      setError(json.error || 'Không đổi được trạng thái bỏ qua')
      return
    }
    await load(horizon)
  }

  const saveThreshold = async (id: string, value: string) => {
    setError(null)
    const res = await fetch('/api/meta/reserve', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, threshold: value.trim() === '' ? null : Number(value.replace(/[^\d.]/g, '')) }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) {
      setError(json.error || 'Không lưu được ngưỡng')
      return
    }
    setEditing(null)
    setEditValue('')
    await load(horizon)
  }

  const accounts = data?.accounts ?? []
  const staleDays = accounts.reduce((max, row) => Math.max(max, row.staleDays ?? 0), 0)
  // The threshold is read off billing history, so a stale billing sync means a stale threshold.
  const newestCharge = accounts.reduce<string | null>(
    (latest, row) => (row.thresholdLastSeen && (!latest || row.thresholdLastSeen > latest) ? row.thresholdLastSeen : latest),
    null,
  )
  const chargeAgeDays = newestCharge && data?.today
    ? Math.round((Date.parse(`${data.today}T00:00:00Z`) - Date.parse(`${newestCharge}T00:00:00Z`)) / 86_400_000)
    : null
  const urgentCount = accounts.filter(row => row.level === 'URGENT' && !row.excluded).length

  return (
    <div className="mb-lg bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20">
      <div className="flex items-center gap-sm px-lg py-md border-b border-outline-variant/20 flex-wrap">
        <span className={`material-symbols-outlined text-[20px] ${urgentCount > 0 ? 'text-error' : 'text-secondary'}`}>
          savings
        </span>
        <div>
          <h3 className="text-title-sm font-semibold text-on-surface">Dự phòng thanh toán Meta</h3>
          <p className="text-label-sm text-on-surface-variant">
            balance + (ngân sách − đã chi hôm nay) ≥ ngưỡng → Meta charge, thẻ phải có sẵn tiền ngưỡng đó
          </p>
        </div>

        <div className="ml-auto flex items-center gap-sm flex-wrap">
          <span className="text-label-sm text-on-surface-variant">Trong</span>
          <div className="flex gap-xs">
            {HORIZONS.map(days => (
              <button
                key={days}
                onClick={() => setHorizon(days)}
                className={`px-md py-xs rounded-lg text-label-sm transition-all ${horizon === days ? 'bg-secondary text-on-secondary' : 'bg-surface-container text-on-surface-variant hover:bg-surface-container-high'}`}
              >
                {days} ngày
              </button>
            ))}
          </div>
          <button
            onClick={refresh}
            disabled={refreshing}
            className="flex items-center gap-xs bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md hover:opacity-90 disabled:opacity-50"
          >
            <span className={`material-symbols-outlined text-[18px] ${refreshing ? 'animate-spin' : ''}`}>sync</span>
            {refreshing ? 'Đang lấy...' : 'Làm mới'}
          </button>
          <button
            onClick={() => setOpen(!open)}
            className="p-xs rounded-lg text-on-surface-variant hover:bg-surface-container"
            aria-label={open ? 'Thu gọn' : 'Mở rộng'}
          >
            <span className="material-symbols-outlined text-[20px]">{open ? 'expand_less' : 'expand_more'}</span>
          </button>
        </div>
      </div>

      {error && (
        <div className="mx-lg mt-md flex items-start gap-sm rounded-lg border border-error/20 bg-error-container/20 px-md py-sm text-error">
          <span className="material-symbols-outlined text-[18px]">error</span>
          <p className="text-body-sm break-all">{error}</p>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-xl">
          <span className="material-symbols-outlined animate-spin text-[24px] text-secondary">sync</span>
        </div>
      ) : accounts.length === 0 ? (
        <p className="px-lg py-lg text-body-sm text-on-surface-variant">Chưa có ad account nào.</p>
      ) : (
        <>
          <div className="px-lg py-md flex items-start gap-xl flex-wrap">
            <div>
              <p className="text-label-sm text-on-surface-variant">Cần chuẩn bị trong {horizon} ngày</p>
              <p className={`text-display-sm font-bold ${(data?.totalReserveUsd ?? 0) > 0 ? 'text-error' : 'text-on-surface'}`}>
                {fmtUsd(data?.totalReserveUsd ?? 0)}
              </p>
            </div>
            <div className="flex gap-md flex-wrap">
              {(data?.cards ?? []).length === 0 ? (
                <p className="text-body-sm text-on-surface-variant self-center">
                  Không có tài khoản nào tới ngưỡng trong {horizon} ngày tới.
                </p>
              ) : data?.cards.map(card => (
                <div
                  key={card.cardLast4 ?? 'unknown'}
                  className={`rounded-lg px-md py-sm border ${card.level === 'URGENT' ? 'border-error/30 bg-error-container/10' : 'border-outline-variant/30 bg-surface-container/50'}`}
                >
                  <p className="text-label-sm text-on-surface-variant flex items-center gap-xs">
                    <span className="material-symbols-outlined text-[16px]">credit_card</span>
                    {card.cardLast4 ? `Thẻ **** ${card.cardLast4}` : 'Chưa rõ thẻ'}
                  </p>
                  {card.totals.map(total => (
                    <p key={total.currency} className="text-title-sm font-semibold text-on-surface">
                      {fmtMoney(total.amount, total.currency)}
                    </p>
                  ))}
                  <p className="text-label-sm text-on-surface-variant">
                    {card.accountIds.length} account · ≈ {fmtUsd(card.totalUsd)}
                  </p>
                </div>
              ))}
            </div>
            {chargeAgeDays !== null && chargeAgeDays > 3 && (
              <div className="flex items-start gap-sm rounded-lg border border-amber-300 bg-amber-50 px-md py-sm text-amber-900 max-w-[340px]">
                <span className="material-symbols-outlined text-[18px]">receipt_long</span>
                <p className="text-body-sm">
                  Ngưỡng được suy từ lịch sử billing, mà lịch sử chỉ tới <strong>{fmtDate(newestCharge)}</strong> ({chargeAgeDays} ngày trước).
                  Bấm <strong>Sync Billing</strong> ở trên để ngưỡng cập nhật, hoặc nhập ngưỡng tay.
                </p>
              </div>
            )}
            {staleDays >= 2 && (
              <div className="ml-auto flex items-start gap-sm rounded-lg border border-amber-300 bg-amber-50 px-md py-sm text-amber-900 max-w-[320px]">
                <span className="material-symbols-outlined text-[18px]">schedule</span>
                <p className="text-body-sm">
                  Balance mới nhất đã {staleDays} ngày tuổi. Bấm <strong>Làm mới</strong> để lấy balance và budget hiện tại từ Meta.
                </p>
              </div>
            )}
          </div>

          {open && (
            <div className="overflow-x-auto border-t border-outline-variant/20">
              <table className="w-full text-body-sm">
                <thead className="bg-surface-container/60 text-label-sm text-on-surface-variant">
                  <tr>
                    <th className="text-left px-lg py-sm font-medium">Ad Account</th>
                    <th className="text-right px-md py-sm font-medium">Balance (nợ)</th>
                    <th className="text-right px-md py-sm font-medium">Đã chi hôm nay</th>
                    <th className="text-right px-md py-sm font-medium">Ngân sách còn lại</th>
                    <th className="text-right px-md py-sm font-medium">Dự kiến cuối ngày</th>
                    <th className="text-right px-md py-sm font-medium">Ngưỡng</th>
                    <th className="text-right px-md py-sm font-medium">Còn cách ngưỡng</th>
                    <th className="text-right px-md py-sm font-medium">Cần trên thẻ</th>
                    <th className="text-left px-md py-sm font-medium">Thẻ</th>
                    <th className="text-left px-lg py-sm font-medium">Trạng thái</th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.map(row => (
                    <tr
                      key={row.id}
                      className={`border-t border-outline-variant/10 hover:bg-surface-container/30 ${row.excluded ? 'opacity-50' : ''}`}
                    >
                      <td className="px-lg py-sm">
                        <p className="font-medium text-on-surface">{row.accountName || row.accountId}</p>
                        <p className="text-label-sm text-on-surface-variant">{row.accountId}</p>
                      </td>
                      <td className="px-md py-sm text-right tabular-nums">{fmtMoney(row.balance, row.currency)}</td>
                      <td className="px-md py-sm text-right tabular-nums">
                        {fmtMoney(row.spendToday, row.currency)}
                        {row.plannedDailySpend !== null && (
                          <span className="block text-label-sm text-on-surface-variant">
                            ngân sách {fmtMoney(row.plannedDailySpend, row.currency)}/ngày
                          </span>
                        )}
                      </td>
                      <td className="px-md py-sm text-right tabular-nums">
                        {fmtMoney(row.budgetRemaining, row.currency)}
                        {row.activeCampaignCount !== null && (
                          <span className="block text-label-sm text-on-surface-variant">{row.activeCampaignCount} campaign đang chạy</span>
                        )}
                      </td>
                      <td className="px-md py-sm text-right tabular-nums" title={formulaHint(row)}>
                        <span className={row.willCross ? 'text-error font-semibold' : ''}>
                          {fmtMoney(row.projectedBalance, row.currency)}
                        </span>
                        <span className="block text-label-sm text-on-surface-variant">{formulaHint(row)}</span>
                      </td>
                      <td className="px-md py-sm text-right">
                        {editing === row.id ? (
                          <div className="flex items-center justify-end gap-xs">
                            <input
                              value={editValue}
                              onChange={e => setEditValue(e.target.value)}
                              onKeyDown={e => { if (e.key === 'Enter') saveThreshold(row.id, editValue) }}
                              placeholder="để trống = tự đoán"
                              autoFocus
                              className="w-[150px] bg-surface-container border border-outline-variant/30 rounded-lg px-sm py-xs text-body-sm outline-none focus:ring-2 focus:ring-secondary"
                            />
                            <button
                              onClick={() => saveThreshold(row.id, editValue)}
                              className="p-xs rounded-lg text-secondary hover:bg-surface-container"
                              aria-label="Lưu ngưỡng"
                            >
                              <span className="material-symbols-outlined text-[18px]">check</span>
                            </button>
                            <button
                              onClick={() => { setEditing(null); setEditValue('') }}
                              className="p-xs rounded-lg text-on-surface-variant hover:bg-surface-container"
                              aria-label="Huỷ"
                            >
                              <span className="material-symbols-outlined text-[18px]">close</span>
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => { setEditing(row.id); setEditValue(row.thresholdSource === 'MANUAL' && row.threshold !== null ? String(row.threshold) : '') }}
                            className="group inline-flex flex-col items-end"
                            title="Sửa ngưỡng"
                          >
                            <span className="tabular-nums group-hover:underline">{fmtMoney(row.threshold, row.currency)}</span>
                            <span className="text-label-sm text-on-surface-variant">
                              {row.thresholdSource === 'MANUAL'
                                ? 'nhập tay'
                                : row.thresholdSource === 'INFERRED'
                                  ? `đoán · charge lớn nhất 21 ngày · x${row.thresholdOccurrences} · ${fmtDate(row.thresholdLastSeen)}`
                                  : 'bấm để nhập'}
                            </span>
                          </button>
                        )}
                      </td>
                      <td className="px-md py-sm text-right tabular-nums">
                        {fmtMoney(row.headroom, row.currency)}
                        <span className="block text-label-sm text-on-surface-variant">
                          {row.willCross && row.level === 'URGENT' ? 'vượt hôm nay' : fmtDays(row.daysToCharge)}
                        </span>
                      </td>
                      <td className={`px-md py-sm text-right tabular-nums ${!row.excluded && row.level === 'URGENT' ? 'text-error font-semibold' : ''}`}>
                        {row.excluded || (row.level === 'OK' && (row.daysToCharge === null || row.daysToCharge > (data?.horizonDays ?? 3)))
                          ? '—'
                          : fmtMoney(row.chargeAmount, row.currency)}
                      </td>
                      <td className="px-md py-sm text-on-surface-variant">
                        {row.fundingCardLast4 ? `**** ${row.fundingCardLast4}` : '—'}
                      </td>
                      <td className="px-lg py-sm">
                        <span className={`inline-flex px-sm py-[2px] rounded-md text-label-sm ${row.excluded ? 'bg-surface-container text-on-surface-variant' : LEVEL_STYLE[row.level]}`}>
                          {row.excluded ? 'Bỏ qua' : LEVEL_LABEL[row.level]}
                        </span>
                        <button
                          onClick={() => toggleExcluded(row.id, !row.excluded)}
                          className="ml-xs p-[2px] rounded-md text-on-surface-variant hover:bg-surface-container align-middle"
                          title={row.excluded ? 'Tính lại account này vào dòng tiền' : 'Bỏ account này khỏi dự phòng + Pending Meta'}
                        >
                          <span className="material-symbols-outlined text-[16px]">
                            {row.excluded ? 'visibility' : 'visibility_off'}
                          </span>
                        </button>
                        {row.reasons.length > 0 && (
                          <p className="mt-xs text-label-sm text-on-surface-variant">
                            {row.reasons.map(reason => REASON_LABELS[reason] ?? reason).join(' · ')}
                          </p>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}
