import type { LibraryProductStatus, SlotStatus } from '@/lib/artwork-fields'
import type { Tone } from '../../components/model'

export const LIBRARY_META: Record<SlotStatus | LibraryProductStatus, { label: string; tone: Tone; icon: string }> = {
  NO_MAPPING: { label: 'Chưa mapping', tone: 'bad', icon: 'account_tree' },
  READY: { label: 'Sẵn sàng', tone: 'ok', icon: 'check_circle' },
  NEEDS_REVIEW: { label: 'Chờ xác nhận', tone: 'brand', icon: 'rate_review' },
  NEEDS_FONTS: { label: 'Thiếu font', tone: 'warn', icon: 'font_download_off' },
  PARSING: { label: 'Đang đọc', tone: 'brand', icon: 'hourglass_top' },
  QUEUED: { label: 'Chờ đọc', tone: 'idle', icon: 'schedule' },
  ERROR: { label: 'Lỗi', tone: 'bad', icon: 'error' },
  EMPTY: { label: 'Chưa có PSD', tone: 'idle', icon: 'upload_file' },
  NO_TEMPLATE: { label: 'Chưa có template', tone: 'warn', icon: 'dashboard_customize' },
}

export const LIBRARY_FILTERS: { value: LibraryProductStatus | ''; label: string }[] = [
  { value: '', label: 'Tất cả' },
  { value: 'NO_MAPPING', label: 'Chưa mapping' },
  { value: 'NO_TEMPLATE', label: 'Chưa có template' },
  { value: 'EMPTY', label: 'Chưa có PSD' },
  { value: 'ERROR', label: 'Lỗi' },
  { value: 'NEEDS_FONTS', label: 'Thiếu font' },
  { value: 'NEEDS_REVIEW', label: 'Chờ xác nhận' },
  { value: 'QUEUED', label: 'Chờ đọc' },
  { value: 'PARSING', label: 'Đang đọc' },
  { value: 'READY', label: 'Sẵn sàng' },
]

export function isBusy(status: string | null | undefined): boolean {
  return status === 'QUEUED' || status === 'PARSING'
}

export function fmtDate(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleDateString('en-US') : '—'
}
