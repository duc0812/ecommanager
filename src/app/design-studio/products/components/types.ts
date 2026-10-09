import type { LayerFit, LayerMapEntry, ProfileStatus } from '../../components/types'

export type ProductListRow = {
  key: string; storeId: string; shop: string; shopifyProductId: string; title: string; imageUrl: string | null
  variantsSeen: number; orderCount: number; openTasks: number; status: ProfileStatus; hasProfile: boolean; lastOrderAt: string
}

export type ProfileOverride = { combo: Record<string, string>; supplierProductId: string }

export type SavedProfile = {
  id: string; title: string; imageUrl: string | null; supplierProductId: string | null; overrides: ProfileOverride[]
  printTemplateId: string | null; masterArtworkUrl: string | null; masterArtworkId: string | null
  layerMap: LayerMapEntry[]; notes: string | null; updatedAt: string
}

export type SupplierProductOption = {
  id: string; sku: string; productName: string | null; productType: string | null; baseCost?: number | null; supplierId: string
  variant1Name: string | null; variant1Value: string | null; variant2Name: string | null; variant2Value: string | null
  supplier: { name: string; code: string }
}

export type ProductVariant = {
  shopifyVariantId: string; variantTitle: string | null; options: Record<string, string>; supplierId: string | null; supplierSku: string | null
}

export type ProductDetail = {
  key: string; storeId: string; shop: string; shopifyProductId: string
  profile: SavedProfile | null
  status: ProfileStatus
  summary: {
    title: string; imageUrl: string | null; variants: ProductVariant[]; orderCount: number; openTasks: number; lastOrderAt: string | null
  }
  observedFields: string[]
  supplierProducts: SupplierProductOption[]
  templates: { id: string; name: string; supplierId: string; supplierSku: string | null }[]
}

export type SaveResponse = {
  profile: SavedProfile
  reevaluation: { ordersUpdated: number; tasksTouched: number; errors: string[] }
}

export type OverrideRow = { option: string; value: string; extra: Record<string, string>; supplierProductId: string }
export type LayerRow = { field: string; observed: boolean; layer: string; font: string; maxChars: string; fit: LayerFit }
