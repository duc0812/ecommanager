export type ScaleViewRow = {
  id: string
  targetId: string
  label: string
  side: 'both' | 'front' | 'back'
  blankFile: string | null
  blankDescription: string
  unprintedParts: string
  sortOrder: number
}

export type ScaleThumb = { viewId: string; file: string }

export type ScaleTargetView = {
  id: string
  name: string
  sku: string
  updatedAt: string
  ready: boolean
  active?: boolean
  views?: ScaleViewRow[]
  thumbs?: ScaleThumb[]
}

export function targetThumbs(t: ScaleTargetView): ScaleThumb[] {
  return t.thumbs ?? (t.views ?? []).filter(v => v.blankFile).map(v => ({ viewId: v.id, file: v.blankFile! }))
}

export type ScaleJobStatus = 'describing' | 'running' | 'done' | 'failed'

export type ScaleJobView = {
  id: string
  targetId: string
  targetName: string
  model: string
  status: ScaleJobStatus
  sourceFile: string | null
  resultFile: string | null
  error: string | null
  cost: string | null
  durationMs: number | null
  parentJobId: string | null
  createdBy: string | null
  createdByName?: string | null
  createdAt: string
  hasDesign: boolean
  canRetryViews?: boolean
  views: { label: string; status: 'waiting' | 'running' | 'done' | 'failed' }[]
}

export type ScaleSettingsView = {
  imageModel: string
  fallbackModel: string
  allowFallback: boolean
  visionModel: string | null
  resolution: string
  viewAspect: string
  effectiveVisionModel: string
  imageKeyMasked: string | null
  imageKeySource: 'creative' | 'cs' | 'env' | null
  visionKeyMasked: string | null
}

export const SCALE_STATUS_LABEL: Record<ScaleJobStatus, string> = {
  describing: 'Đang đọc thiết kế',
  running: 'Đang tạo ảnh',
  done: 'Xong',
  failed: 'Lỗi',
}

export const scaleFileUrl = (kind: 'targets' | 'jobs' | 'views', id: string, name: string, version?: string) =>
  `/api/tools/scale/file/${kind}/${id}/${name}${version ? `?v=${encodeURIComponent(version)}` : ''}`

export async function postJson(url: string, body?: unknown, method = 'POST'): Promise<any> {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json.error || `Lỗi ${res.status}`)
  return json
}
