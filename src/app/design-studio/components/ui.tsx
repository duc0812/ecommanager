import type { ReactNode } from 'react'
import type { Readiness, TaskStatus } from './types'
import type { Tone } from './model'

export const card = 'bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20'
export const btn = 'inline-flex items-center gap-xs rounded-lg border border-outline-variant/40 bg-surface-container-lowest px-md py-xs text-label-sm font-semibold text-on-surface hover:bg-surface-container-low disabled:opacity-40 disabled:cursor-not-allowed'
export const btnPrimary = 'inline-flex items-center gap-xs rounded-lg bg-secondary text-on-secondary px-md py-xs text-label-sm font-semibold hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed'
export const btnWarn = `${btn} text-amber-900`
export function chip(on: boolean) {
  return `inline-flex items-center gap-xs rounded-full border px-sm py-[2px] text-label-sm ${on ? 'bg-secondary/10 text-secondary border-transparent font-semibold' : 'bg-surface-container-lowest border-outline-variant/40 text-on-surface-variant'}`
}
export const input = 'rounded-lg border border-outline-variant/40 bg-surface-container-lowest px-sm py-xs text-body-sm text-on-surface min-w-0'

export const btnMd = 'inline-flex items-center gap-xs h-10 px-[14px] rounded-lg border border-outline-variant bg-surface-container-lowest text-body-sm font-semibold text-on-surface hover:bg-surface-container-low disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap'
export const btnPrimaryMd = 'inline-flex items-center gap-xs h-10 px-md rounded-lg bg-secondary text-on-secondary text-body-sm font-semibold hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap'
export const btnTonal = 'inline-flex items-center gap-xs h-9 px-[14px] rounded-lg bg-secondary/10 text-secondary text-body-sm font-semibold hover:bg-secondary/15 disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap'
export const btnText = 'inline-flex items-center gap-xs h-8 px-sm rounded-lg text-secondary text-body-sm font-semibold hover:bg-secondary/10 disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap'
export const iconBtn = 'inline-grid place-items-center w-8 h-8 rounded-lg text-on-surface-variant hover:bg-surface-container-low hover:text-on-surface disabled:opacity-40 disabled:cursor-not-allowed shrink-0'
export const field = 'h-10 rounded-lg border border-outline-variant bg-surface-container-lowest px-sm text-body-sm text-on-surface min-w-0'
export const fieldLabel = 'flex flex-col gap-xs text-label-sm text-on-surface-variant'
export const popover = 'absolute z-40 rounded-xl bg-surface-container-lowest border border-outline-variant/60 shadow-overlay'
export const menuItem = 'flex items-center gap-sm w-full min-h-9 px-sm py-xs rounded-lg text-body-sm text-on-surface text-left hover:bg-surface-container-low disabled:opacity-40 disabled:cursor-not-allowed'

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

export function Pill({ tone, icon, children, size = 'sm', title }: { tone: Tone; icon?: string; children: ReactNode; size?: 'sm' | 'md'; title?: string }) {
  const shape = size === 'md' ? 'h-6 rounded-full px-sm font-medium' : 'rounded-md px-xs font-semibold'
  return (
    <span title={title} className={`inline-flex items-center gap-xs text-label-sm whitespace-nowrap ${shape} ${TONE[tone]}`}>
      {icon && <Icon name={icon} className={size === 'md' ? 'text-[14px]' : 'text-[13px]'} />}
      {children}
    </span>
  )
}

export function fmtDate(iso: string) { return new Date(iso).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }) }
export function fmtDateTime(iso: string) { return new Date(iso).toLocaleString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit' }) }

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
