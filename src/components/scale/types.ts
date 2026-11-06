export type ScaleTargetView = {
  id: string
  name: string
  sku: string
  blankFile: string | null
  blankDescription: string
  unprintedParts: string
  active: boolean
  sortOrder: number
  candidateFile: string | null
  candidateStatus: 'running' | 'ready' | 'failed' | null
  candidateError: string | null
  updatedAt: string
  ready: boolean
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
  prompt?: string | null
  designJson?: string | null
}

export type ScaleSettingsView = {
  imageModel: string
  fallbackModel: string
  allowFallback: boolean
  visionModel: string | null
  resolution: string
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

export const scaleFileUrl = (kind: 'targets' | 'jobs', id: string, name: string, version?: string) =>
  `/api/tools/scale/file/${kind}/${id}/${name}${version ? `?v=${encodeURIComponent(version)}` : ''}`

export async function postJson(url: string, body?: unknown, method = 'POST'): Promise<any> {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json.error || `Lỗi ${res.status}`)
  return json
}
