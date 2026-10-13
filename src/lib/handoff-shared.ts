import type { WorkspaceLine } from '@/lib/design-studio'

export type HandoffMode = 'API' | 'CSV'

export type HandoffPush = { status: string; supplierOrderCode: string | null; externalOrderId: string }

export type HandoffState = {
  pending: boolean
  blocked: string | null
  mode: HandoffMode
  apiName: string | null
  apiNote: string | null
  handedOff: { at: string; mode: HandoffMode; byName: string | null } | null
  canUndo: boolean
  push: HandoffPush | null
}

export type HandoffLine = { line: WorkspaceLine; slots: string[]; taskKey: string; apiSku: string | null; driveFolderUrl: string | null }

export type HandoffCard = {
  order: {
    id: string; orderNumber: string; placedAt: string; storeName: string; pipelineStatus: string
    customerName: string | null; country: string | null; countryCode: string | null; countryName: string | null; shipTo: string | null
  }
  suppliers: { id: string; name: string; code: string }[]
  lines: HandoffLine[]
  state: HandoffState
}

export const HANDOFF_LABELS = {
  api: (name: string | null) => `Chuyển supplier qua API (${name ?? 'API'})`,
  csv: 'Lưu chờ xuất CSV',
  generic: 'Chuyển supplier',
  wait: 'Chờ người phụ trách xuất xưởng',
  savedCsv: 'Đã lưu chờ xuất CSV',
  undo: 'Hoàn tác',
} as const

export function pushChipLabel(push: HandoffPush): string {
  const code = push.supplierOrderCode ?? push.externalOrderId
  return push.status === 'CREATED' ? `Đã gửi PGprints ${code}` : `Đang gửi PGprints ${code} — chưa rõ kết quả`
}
