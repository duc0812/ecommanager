import type { LibraryProductStatus } from '@/lib/artwork-fields'
import type { TaskLibraryState } from '@/lib/artwork-library-types'
import type { RenderJobView } from '@/lib/artwork-render-eligibility'
import type { HandoffCard, HandoffLine, HandoffPush, HandoffState } from '@/lib/handoff-shared'
import type { FileKind } from '@/lib/task-files'

export type { FileKind, HandoffCard, HandoffLine, HandoffPush, HandoffState }

export type TaskStatus = 'NEW' | 'ASSIGNED' | 'DOING' | 'REVIEW' | 'REJECTED' | 'ASK_CUSTOMER' | 'DONE' | 'CANCELLED'
export type Readiness = 'AUTO' | 'LOW' | 'MANUAL'

export type Me = { id: string; name: string; role: string; isLeader: boolean; canApprove: boolean; canHandoff: boolean; canEditNote?: boolean }

export type TaskRow = {
  id: string; taskKey: string; status: TaskStatus; readiness: Readiness; assigneeId: string | null; assigneeName: string | null
  kpi: number; dueAt: string | null; slaHours: number; rejectReasons: string[]; rejectNote: string | null
  orderId: string; orderNumber: string; placedAt: string; shopifyLineId: string; linePosition: number
  sku: string | null; productTitle: string; variantTitle: string | null; previewUrl: string | null; imageUrl: string | null
  supplierName: string | null; customized: boolean; storeName: string
}

export type TemplateArea = { name: string; x: number; y: number; w: number; h: number }

export type TemplateRow = {
  id: string; name: string; widthPx: number; heightPx: number; dpi: number; bleedIn: number; safeIn: number; mirror: boolean
  areas: TemplateArea[]; guideImageUrl: string | null; templateUrl: string | null
}

export type TemplateListRow = TemplateRow & { supplierId: string; supplierSku: string | null; supplierName: string; supplierCode: string }

export type ArtworkRow = {
  id: string; kind: FileKind; printArea: string; version: number; fileName: string; size: number
  mimeType: string; uploadedById: string | null; createdAt: string; url: string
  widthPx: number | null; heightPx: number | null
  storage: 'LOCAL' | 'DRIVE'; driveWebViewLink: string | null
  source: 'MANUAL' | 'AUTO'; previewUrl: string | null
}

export type WorkspaceLine = {
  id: string; shopifyLineId: string; linePosition: number; sku: string | null; productTitle: string; variantTitle: string | null
  qty: number; isNonProduct: boolean; customized: boolean
  variantOptions: Record<string, string>
  attributesLoaded: boolean
  personalization: { key: string; value: string; source?: 'customall' }[]
  customallPending: boolean
  customerDesignLink: string | null
  customizedUrl: string | null
  previewUrl: string | null
  imageUrl: string | null
  sourcePrintFiles: { printArea: string; url: string }[]
  supplier: { id: string; name: string; code: string; apiType?: string | null } | null
  supplierSku: string | null
  templateUrl: string | null
  masterArtworkUrl: string | null
  libraryDesignLink: string | null
  designStatus: string
  designDriveLink: string | null
  designNote: string | null
  printAreas: string[]
  artworks: ArtworkRow[]
}

export type OrderInfo = {
  id: string; shopifyOrderNumber: string; placedAt: string; pipelineStatus: string; orderType: string
  designReady: boolean; trelloCardUrl: string | null
  shipTo?: { countryCode: string | null; countryName: string | null; place: string | null }
  addOns?: AddOn[]
  store: { shop: string; projectId: string; projectName: string }
}

export type AddOn = { title: string; variantTitle: string | null; qty: number; details: string }

export type TaskEvent = { id: string; type: string; message: string; actorName: string | null; createdAt: string }

export type TrelloMode = 'BOTH' | 'READ_ONLY' | 'OFF'
export type DesignSettings = { slaCustomHours: number; slaNonCustomHours: number; kpiByType: Record<string, number>; rejectReasons: string[]; designerCanApprove: boolean; trelloMode: TrelloMode }

export type LayerFit = 'shrink' | 'wrap' | 'none'
export type LayerMapEntry = { field: string; layer: string; font?: string; maxChars?: number; fit: LayerFit }
export type TaskProfile = { key: string; status: LibraryProductStatus; layerMap: LayerMapEntry[] }

export type TaskDetail = {
  task: TaskRow; line: WorkspaceLine; order: OrderInfo; template: TemplateRow | null
  profile: TaskProfile | null; profileRouteKey: string | null
  events: TaskEvent[]; assignable: { id: string; name: string }[]; settings: DesignSettings; prevStatus: TaskStatus | null
  slots: string[]; me: Me; driveConnected: boolean
  driveFolder?: { url: string } | null
  library: TaskLibraryState | null
  autoRender: RenderJobView | null
  handoff?: HandoffState | null
}

export type ReviewCard = {
  task: TaskRow; line: WorkspaceLine; slots: string[]; push?: HandoffPush | null
  template?: TemplateRow | null; profile?: TaskProfile | null; library?: TaskLibraryState | null; shipTo?: OrderInfo['shipTo'] | null
}

export type TransitionBody = {
  to: TaskStatus; note?: string; reasons?: string[]; assigneeId?: string; kpi?: number; dueHours?: number; continue?: boolean
}
