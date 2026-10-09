import type { ArtworkField, EntryStatus, FixedText, LibraryProductStatus, SlotStatus } from '@/lib/artwork-fields'

export type LibraryFileView = {
  id: string; kind: string; fileName: string; size: number; storage: string; driveWebViewLink: string | null; url: string; createdAt: string
}

export type LibraryEntryView = {
  id: string; storeId: string; shopifyProductId: string; printTemplateId: string; supplierId: string
  status: EntryStatus; psd: LibraryFileView | null; artwork: LibraryFileView | null; preview: LibraryFileView | null
  fields: ArtworkField[]; fixedTexts: FixedText[]; missingFonts: string[]; warnings: string[]
  checkScore: number | null; error: string | null; parsedAt: string | null; approvedAt: string | null; approvedByName: string | null
  notes: string | null; updatedAt: string
  job: { id: string; status: string; attempts: number; error: string | null; createdAt: string } | null
}

export type LibraryTemplateView = {
  id: string; name: string; widthPx: number; heightPx: number; dpi: number; bleedIn: number; safeIn: number; mirror: boolean
  areas: { name: string; x: number; y: number; w: number; h: number }[]; guideImageUrl: string | null; templateUrl: string | null
}

export type LibrarySlot = {
  key: string
  supplier: { id: string; name: string; code: string }
  supplierSkus: string[]
  variants: string
  lineCount: number
  template: LibraryTemplateView | null
  status: SlotStatus
  entry: LibraryEntryView | null
}

export type LibraryChip = { supplierName: string; templateName: string | null; status: SlotStatus }

export type LibraryListRow = {
  key: string; storeId: string; shop: string; shopifyProductId: string; title: string; imageUrl: string | null
  orderCount: number; openTasks: number; unmapped: number; status: LibraryProductStatus; chips: LibraryChip[]; staleCount: number
}

export type LibraryProductDetail = {
  key: string; storeId: string; shop: string; storeName: string; shopifyProductId: string; title: string; imageUrl: string | null
  status: LibraryProductStatus; slots: LibrarySlot[]; stale: Array<{ template: LibraryTemplateView; supplier: { id: string; name: string; code: string }; entry: LibraryEntryView }>
  unmapped: number; observedFields: string[]; openTasks: number; orderCount: number
}

export type LibraryFontRow = {
  id: string; postscriptName: string; family: string; style: string; size: number; fileId: string; fileName: string
  storage: string; usedBy: number; createdAt: string
}

export type TaskLibraryState = { key: string; entryId: string | null; status: EntryStatus | 'NONE'; label: 'Sẵn sàng' | 'Thiếu' | 'Đang đọc' }
