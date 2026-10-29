'use client'
import type { QaLevel, QaResult, QaStatus } from './ai-qa'
import { Icon, Pill, card, fmtDateTime } from './ui'
import type { Tone } from './model'

const STATUS: Record<QaStatus, { label: string; tone: Tone; icon: string }> = {
  none: { label: 'Chưa có file', tone: 'idle', icon: 'hourglass_empty' },
  pass: { label: 'Đạt hết', tone: 'ok', icon: 'check_circle' },
  warn: { label: 'Có cảnh báo', tone: 'warn', icon: 'warning' },
  error: { label: 'Có lỗi', tone: 'bad', icon: 'error' },
}

const ROW: Record<QaLevel, { icon: string; box: string; icon_: string; label: string }> = {
  pass: { icon: 'check_circle', box: 'bg-surface-container-low', icon_: 'text-on-tertiary-container', label: 'text-on-surface' },
  warn: { icon: 'warning', box: 'bg-amber-50 border border-amber-200', icon_: 'text-amber-600', label: 'text-amber-900' },
  error: { icon: 'error', box: 'bg-error-container/60 border border-error/30', icon_: 'text-error', label: 'text-on-error-container' },
}

export default function AiQaPanel({ qa }: { qa: QaResult }) {
  const s = STATUS[qa.status]
  return (
    <section aria-label="Kết quả QA" className={`${card} px-md pt-sm pb-md flex flex-col gap-sm`}>
      <div className="flex flex-wrap items-center gap-sm">
        <Icon name="auto_awesome" className="text-[20px] text-secondary" />
        <span className="text-body-sm font-semibold text-on-surface">QA tự động</span>
        <Pill tone={s.tone} icon={s.icon} size="md">{s.label}</Pill>
        {qa.newest && (
          <span className="text-label-sm text-on-surface-variant">
            theo file mới nhất {qa.newest.printArea} v{qa.newest.version} · {fmtDateTime(qa.newest.createdAt)}
          </span>
        )}
      </div>
      {qa.status === 'none' ? (
        <div className="flex items-center gap-sm rounded-lg bg-surface-container-low px-sm py-sm text-body-sm text-on-surface-variant">
          <Icon name="hourglass_empty" className="text-[20px]" />
          Chưa có file in. QA tự chạy ngay khi có file trên canvas — không cần tick tay.
        </div>
      ) : (
        <div className="grid grid-cols-4 gap-sm">
          {qa.items.map(it => {
            const r = ROW[it.level]
            return (
              <div key={it.key} title={it.detail} className={`flex items-start gap-sm rounded-lg px-sm py-sm min-w-0 ${r.box}`}>
                <Icon name={r.icon} className={`text-[20px] ${r.icon_}`} />
                <div className="min-w-0 flex flex-col">
                  <span className={`text-body-sm font-semibold ${r.label}`}>{it.label}</span>
                  <span className="text-label-sm text-on-surface-variant line-clamp-2 break-words">{it.detail}</span>
                </div>
              </div>
            )
          })}
        </div>
      )}
      <span className="text-label-sm text-on-surface-variant">
        Máy kiểm khổ, DPI, định dạng, phủ panel và đủ vùng. So chữ với text khách, màu và preview cần AI nhìn ảnh — chưa có, người duyệt tự soi ở hàng So sánh.
      </span>
    </section>
  )
}
