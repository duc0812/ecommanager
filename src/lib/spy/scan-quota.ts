import type { UserRole } from '@/lib/roles'

export const SCAN_DAILY_LIMIT = 2

export function isUnlimited(role: UserRole): boolean {
  return role === 'SUPERADMIN' || role === 'ADMIN'
}

export function vnDay(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}
