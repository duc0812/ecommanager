import type { Tone } from './model'

export type DriveHealthView = {
  state: 'not_connected' | 'needs_reconnect' | 'connected'
  pending: number
  quota: { limit: number | null; usage: number; percent: number | null; checkedAt: string } | null
  quotaWarning: boolean
  canConnect: boolean
  canPush: boolean
}

export type DriveBannerItem = { id: 'state' | 'quota' | 'pending'; tone: Tone; icon: string; text: string; setupLink: boolean; pushButton: boolean }

const GB = 1024 ** 3
const MB = 1024 ** 2

export function fmtStorage(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(bytes >= 100 * GB ? 0 : 1)} GB`
  if (bytes >= MB) return `${Math.round(bytes / MB)} MB`
  return `${Math.max(0, Math.round(bytes / 1024))} KB`
}

export function quotaLine(quota: { limit: number | null; usage: number; percent: number | null }): string {
  if (!quota.limit) return `${fmtStorage(quota.usage)} đã dùng (không giới hạn)`
  return `${fmtStorage(quota.usage)} / ${fmtStorage(quota.limit)}${quota.percent !== null ? ` (${quota.percent}%)` : ''}`
}

export function driveBannerItems(h: DriveHealthView): DriveBannerItem[] {
  const items: DriveBannerItem[] = []
  const waiting = h.pending > 0 ? ` · ${h.pending} file đang nằm trên server` : ''
  if (h.state === 'not_connected') {
    items.push({ id: 'state', tone: 'idle', icon: 'info', text: 'File đang lưu trên server, chưa có bản trên Google Drive', setupLink: h.canConnect, pushButton: false })
    return items
  }
  if (h.state === 'needs_reconnect') {
    items.push({ id: 'state', tone: 'bad', icon: 'cloud_off', text: `Google Drive cần kết nối lại — file mới chỉ lưu trên server${waiting}`, setupLink: h.canConnect, pushButton: false })
    return items
  }
  if (h.quotaWarning && h.quota) {
    items.push({ id: 'quota', tone: 'warn', icon: 'warning', text: `Google Drive sắp đầy: đã dùng ${quotaLine(h.quota)}`, setupLink: false, pushButton: false })
  }
  if (h.pending > 0) {
    items.push({ id: 'pending', tone: 'idle', icon: 'cloud_upload', text: `${h.pending} file chờ đẩy lên Drive`, setupLink: false, pushButton: h.canPush })
  }
  return items
}
