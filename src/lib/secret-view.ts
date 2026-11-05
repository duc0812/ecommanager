import type { UserRole } from '@/lib/roles'

/** The settings views carry a partly masked key (`ab12…yz89`) next to the `has…` flag. Only a Super Admin gets the masked string. */
export function maskedForSuperadminOnly<T extends object>(user: { role: UserRole }, view: T, maskedKeys: readonly (keyof T)[]): Partial<T> {
  if (user.role === 'SUPERADMIN') return view
  const shown: Partial<T> = { ...view }
  for (const key of maskedKeys) delete shown[key]
  return shown
}

/** What a settings page prints beside a secret: the masked value for a Super Admin, otherwise just whether one is set. */
export function secretStatusLabel(has: boolean, masked?: string | null) {
  if (!has) return 'Chưa cấu hình'
  return masked ? `đang dùng ${masked}` : 'Đã cấu hình'
}
