import type { ArtworkRow, TemplateRow } from '@/app/design-studio/components/types'

export const OUTSOURCE_STATUS: Record<string, string> = {
  ASSIGNED: 'Được giao', DOING: 'Đang làm', REVIEW: 'Chờ duyệt', REJECTED: 'Cần sửa',
  ASK_CUSTOMER: 'Chờ phản hồi', DONE: 'Hoàn tất', CANCELLED: 'Đã hủy', NEW: 'Được giao',
}

export type OutsourceRow = { code: string; revision: number; status: string; dueAt: string | null; updatedAt: string; referenceUrl: string | null }
export type OutsourceDetail = OutsourceRow & {
  internalTaskKey?: string
  brief: string; templateLabel: string; templateUrl: string; downloadUrl: string; templateVersion: string
  templateChanged: boolean; templateConfirmed: boolean; template: TemplateRow; slots: string[]
  personalization: { key: string; value: string }[]; artworks: ArtworkRow[]
  technicalOptions: { key: string; value: string }[]
  messages: { id: string; side: string; message: string; createdAt: string }[]
  qa: { area: string; state: 'ok' | 'missing' | 'warning'; message: string }[]
  canManage: boolean
}

export type OutsourceManagement = {
  selectedFieldIndexes: number[]
  reference: 'none' | 'preview' | 'image'
  assignment: { code: string; revision: number; active: boolean; assigneeId: string; brief: string; templateLabel: string; templateUrl: string } | null
  users: { id: string; name: string }[]; brief: string; templateLabel: string; templateUrl: string; hasTemplate: boolean
  personalization: { key: string; value: string }[]; hasPreview: boolean; hasImage: boolean
  technicalOptions: { key: string; value: string }[]
}
