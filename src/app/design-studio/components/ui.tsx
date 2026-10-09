import type { ReactNode } from 'react'
import type { Readiness, TaskStatus } from './types'
import type { Tone } from './model'

export const card = 'bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20'
export const btn = 'inline-flex items-center gap-xs rounded-lg border border-outline-variant/40 bg-surface-container-lowest px-md py-xs text-label-sm font-semibold text-on-surface hover:bg-surface-container-low disabled:opacity-40 disabled:cursor-not-allowed'
export const btnPrimary = 'inline-flex items-center gap-xs rounded-lg bg-secondary text-on-secondary px-md py-xs text-label-sm font-semibold hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed'
export const btnWarn = `${btn} text-amber-900`
export const input = 'rounded-lg border border-outline-variant/40 bg-surface-container-lowest px-sm py-xs text-body-sm text-on-surface min-w-0'

const TONE: Record<Tone, string> = {
  ok: 'bg-tertiary/15 text-tertiary',
  warn: 'bg-amber-100 text-amber-900',
  bad: 'bg-error-container text-on-error-container',
  idle: 'bg-surface-container text-on-surface-variant',
  brand: 'bg-secondary/10 text-secondary',
}

export const TEXT_TONE: Record<Tone, string> = {
  ok: 'text-on-tertiary-container',
  warn: 'text-amber-900',
  bad: 'text-error',
  idle: 'text-on-surface-variant',
  brand: 'text-secondary',
}

export const READY_META: Record<Readiness, { label: string; tone: Tone; icon: string }> = {
  AUTO: { label: 'Tự động đạt', tone: 'ok', icon: 'bolt' },
  LOW: { label: 'Cần chỉnh', tone: 'warn', icon: 'tune' },
  MANUAL: { label: 'Làm tay', tone: 'idle', icon: 'draw' },
}

export const STATUS_META: Record<TaskStatus, { label: string; tone: Tone }> = {
  NEW: { label: 'Mới', tone: 'brand' },
  ASSIGNED: { label: 'Đã giao', tone: 'brand' },
  DOING: { label: 'Đang làm', tone: 'warn' },
  REVIEW: { label: 'Chờ duyệt', tone: 'brand' },
  ASK_CUSTOMER: { label: 'Hỏi khách', tone: 'bad' },
  REJECTED: { label: 'Trả lại sửa', tone: 'bad' },
  DONE: { label: 'Xong', tone: 'ok' },
  CANCELLED: { label: 'Đã huỷ', tone: 'idle' },
}

export function Icon({ name, className = '' }: { name: string; className?: string }) {
  return <span className={`material-symbols-outlined align-middle ${className}`} aria-hidden="true">{name}</span>
}

export function Pill({ tone, icon, children }: { tone: Tone; icon?: string; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-xs rounded-md px-xs text-label-sm font-semibold whitespace-nowrap ${TONE[tone]}`}>
      {icon && <Icon name={icon} className="text-[13px]" />}
      {children}
    </span>
  )
}

const AVATAR_BG = ['bg-secondary', 'bg-primary-container', 'bg-on-tertiary-container', 'bg-secondary-container', 'bg-outline']

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

export function Avatar({ name, size = 'sm' }: { name: string; size?: 'sm' | 'md' }) {
  let h = 0
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0
  const dim = size === 'sm' ? 'w-5 h-5 text-[9px]' : 'w-6 h-6 text-[10px]'
  return (
    <span title={name} className={`inline-grid place-items-center rounded-full font-bold text-on-secondary shrink-0 ${dim} ${AVATAR_BG[h % AVATAR_BG.length]}`}>
      {initials(name)}
    </span>
  )
}

export function Card({ icon, title, right, children, className = '' }: { icon: string; title: string; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`${card} min-w-0 ${className}`}>
      <div className="flex items-center gap-sm px-md py-sm border-b border-outline-variant/20 text-body-sm font-semibold text-on-surface">
        <Icon name={icon} className="text-on-surface-variant text-[18px]" />
        <span>{title}</span>
        {right !== undefined && <span className="ml-auto text-label-sm text-on-surface-variant font-medium">{right}</span>}
      </div>
      <div className="px-md py-sm flex flex-col gap-sm">{children}</div>
    </section>
  )
}

export function ErrorBanner({ msg, onClose }: { msg: string; onClose?: () => void }) {
  if (!msg) return null
  return (
    <div role="alert" className="flex items-start gap-sm rounded-lg bg-error-container text-on-error-container px-sm py-xs text-label-sm">
      <Icon name="error" className="text-[16px]" />
      <span className="flex-1">{msg}</span>
      {onClose && <button type="button" onClick={onClose} aria-label="Đóng thông báo lỗi" className="leading-none"><Icon name="close" className="text-[16px]" /></button>}
    </div>
  )
}

export function Note({ tone, icon, children }: { tone: Tone; icon: string; children: ReactNode }) {
  return (
    <div className={`flex items-start gap-sm rounded-lg px-sm py-sm text-body-sm ${TONE[tone]}`}>
      <Icon name={icon} className="text-[18px]" />
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  )
}

export function ExtLink({ href, children }: { href: string; children: ReactNode }) {
  return <a href={href} target="_blank" rel="noreferrer" className="text-secondary hover:underline">{children}</a>
}

export function fmtSize(n: number): string {
  return n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`
}
