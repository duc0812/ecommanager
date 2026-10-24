export type Provider = 'kie' | 'replicate'

export type CatalogModel = {
  provider: Provider
  slug: string
  title: string
  vendor: string
  taskTypes: string[]
  pricing: string | null
  china: boolean
}

export type ModelOption = { name: string; values: string[]; default?: string; required: boolean }
export type ModelForm = { promptField: string | null; imageField: string | null; imageIsArray: boolean; options: ModelOption[] }

export type RefImage = { dataUrl: string; name: string }

export type Job = {
  id: string
  provider: Provider
  model: string
  prompt: string
  input: Record<string, unknown>
  refImages: string[]
  status: 'queued' | 'running' | 'done' | 'failed'
  providerTaskId: string | null
  resultFiles: string[]
  error: string | null
  cost: string | null
  durationMs: number | null
  createdAt: string
  completedAt: string | null
}

export type Draft = { provider: Provider; model: string; prompt: string; images: RefImage[]; options: Record<string, string> }

export const PROVIDER_LABEL: Record<Provider, string> = { kie: 'Kie', replicate: 'Replicate' }
export const STATUS_LABEL: Record<Job['status'], string> = { queued: 'Chờ', running: 'Đang chạy', done: 'Xong', failed: 'Lỗi' }
