import type { MetaBillingSyncJob } from '@/lib/meta-billing-sync-types'
import { isMetaBillingSyncActive } from '@/lib/meta-billing-sync-types'

type Props = {
  job: MetaBillingSyncJob | null
}

const accountStatusLabel = {
  QUEUED: 'Đang chờ',
  RUNNING: 'Đang quét',
  COMPLETED: 'Hoàn tất',
  FAILED: 'Lỗi',
} as const

export default function MetaBillingSyncStatus({ job }: Props) {
  if (!job) return null

  const active = isMetaBillingSyncActive(job)
  const failed = job.status === 'FAILED' || job.status === 'INTERRUPTED'
  const coverageVerified = job.accounts.every(account => account.coverageVerified)
  const warning = job.status === 'COMPLETED_WITH_ERRORS' || (!active && !failed && !coverageVerified)
  const runningAccount = job.accounts.find(account => account.status === 'RUNNING')
  const totalDays = job.accounts.reduce((sum, account) => sum + account.totalDays, 0)
  const completedDays = job.accounts.reduce((sum, account) => sum + Math.min(account.daysCompleted, account.totalDays), 0)
  const progressPercent = totalDays > 0
    ? Math.min(100, Math.floor((completedDays / totalDays) * 100))
    : 0

  return (
    <div className={`mb-lg rounded-xl border px-lg py-md ${
      failed
        ? 'border-error/25 bg-error-container/20'
        : warning
          ? 'border-amber-300 bg-amber-50'
          : active
            ? 'border-secondary/25 bg-secondary/5'
            : 'border-on-tertiary-container/20 bg-on-tertiary-container/10'
    }`}>
      <div className="flex items-start gap-md">
        <span className={`material-symbols-outlined mt-[1px] ${
          failed ? 'text-error' : warning ? 'text-amber-700' : active ? 'animate-spin text-secondary' : 'text-on-tertiary-container'
        }`}>
          {failed ? 'error' : warning ? 'warning' : active ? 'sync' : 'check_circle'}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-sm">
            <p className="text-label-md font-semibold text-primary">
              {active
                ? 'Meta billing đang chạy nền'
                : failed
                  ? 'Meta billing sync đã dừng'
                  : warning
                    ? coverageVerified ? 'Meta billing sync hoàn tất nhưng có lỗi' : 'Cần sync lại để xác nhận coverage theo ngày'
                    : 'Meta billing sync hoàn tất'}
            </p>
            <span className="text-label-sm text-on-surface-variant">
              {progressPercent}% theo ngày · {Math.floor(completedDays)}/{totalDays} ngày
            </span>
          </div>

          {active && (
            <div className="mt-sm h-1.5 overflow-hidden rounded-full bg-surface-container-high">
              <div
                className="h-full rounded-full bg-secondary transition-all duration-500"
                style={{ width: `${Math.max(runningAccount ? 1 : 0, progressPercent)}%` }}
              />
            </div>
          )}

          <div className="mt-sm grid grid-cols-2 gap-sm sm:grid-cols-4">
            <div>
              <p className="text-label-sm text-on-surface-variant">Pages đã quét</p>
              <p className="text-label-md font-semibold text-primary">{job.totals.pages}</p>
            </div>
            <div>
              <p className="text-label-sm text-on-surface-variant">Activities</p>
              <p className="text-label-md font-semibold text-primary">{job.totals.activitiesScanned.toLocaleString('vi-VN')}</p>
            </div>
            <div>
              <p className="text-label-sm text-on-surface-variant">Billing paid tìm thấy</p>
              <p className="text-label-md font-semibold text-primary">{job.totals.paidFound.toLocaleString('vi-VN')}</p>
            </div>
            <div>
              <p className="text-label-sm text-on-surface-variant">Đã lưu database</p>
              <p className="text-label-md font-semibold text-primary">{job.totals.synced.toLocaleString('vi-VN')}</p>
            </div>
          </div>

          {runningAccount && (
            <div className="mt-sm rounded-lg bg-surface-container-lowest/80 px-md py-sm text-body-sm text-on-surface-variant">
              <p>
                Đang quét <strong className="text-primary">{runningAccount.accountName}</strong>
                {runningAccount.since && runningAccount.until ? ` · ${runningAccount.since} → ${runningAccount.until}` : ''}
              </p>
              {runningAccount.message && <p className="mt-xs">{runningAccount.message}</p>}
              <div className="mt-xs flex flex-wrap gap-md text-label-sm">
                <span className="font-semibold text-primary">Tiến độ ngày: {runningAccount.progressPercent}%</span>
                <span>{Math.floor(runningAccount.daysCompleted)}/{runningAccount.totalDays} ngày</span>
                <span>Đã quét đến: {runningAccount.lastCompletedDate ?? 'đang bắt đầu'}</span>
                <span>Dải API: {runningAccount.rangesCompleted}/{runningAccount.rangesTotal}</span>
                <span>Page: {runningAccount.pages}</span>
                <span>Paid: {runningAccount.paidFound}</span>
                {runningAccount.usagePercent !== null && <span>API usage: {runningAccount.usagePercent}%</span>}
                {runningAccount.retryCount > 0 && <span>Tự thử lại: {runningAccount.retryCount}</span>}
              </div>
            </div>
          )}

          {!active && job.error && <p className={`mt-sm text-body-sm ${failed ? 'text-error' : 'text-amber-900'}`}>{job.error}</p>}
          {!active && !coverageVerified && (
            <p className="mt-sm text-body-sm text-amber-900">
              Job này được tạo trước khi có cơ chế coverage theo ngày. Hãy bấm Sync Billing một lần; hệ thống sẽ quét đủ 90 ngày và chỉ báo 100% khi đã chạm ngày hiện tại.
            </p>
          )}

          <div className="mt-sm flex flex-wrap gap-xs">
            {job.accounts.map(account => (
              <span
                key={account.id}
                title={account.error ?? account.message ?? undefined}
                className={`rounded-full px-sm py-xs text-label-sm ${
                  account.status === 'FAILED'
                    ? 'bg-error/10 text-error'
                    : account.status === 'COMPLETED'
                      ? 'bg-on-tertiary-container/10 text-on-tertiary-container'
                      : account.status === 'RUNNING'
                        ? 'bg-secondary/10 text-secondary'
                        : 'bg-surface-container text-on-surface-variant'
                }`}
              >
                {account.accountName}: {accountStatusLabel[account.status]}
                {account.totalDays > 0 ? ` · ${account.progressPercent}% · đến ${account.lastCompletedDate ?? '—'}` : ''}
              </span>
            ))}
          </div>

          {active && (
            <p className="mt-sm text-label-sm text-on-surface-variant">
              Có thể rời trang; tiến trình vẫn chạy. Các nút Sync được khóa để tránh gửi request trùng lên Meta.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
