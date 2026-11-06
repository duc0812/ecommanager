import { isPgprintsSupplier } from '@/lib/pgprints-shared'

export type CsvExportFilters = {
  templateId: string
  projectId: string
  storeId: string | null
  dateFrom: string
  dateTo: string
  pipelineStatus: string
  handoffOnly: boolean
  reExport: boolean
}

type TemplateSupplier = { code?: string | null; apiType?: string | null } | null | undefined

// Only a PGprints file is cut by store (each store has its own PGprints account, and the export refuses to mix them).
// Any other supplier's file holds every store's orders, so the store picked on another page is neither shown nor sent.
export const storePickApplies = (supplier: TemplateSupplier) => isPgprintsSupplier(supplier)

export function csvExportBody(f: CsvExportFilters, supplier: TemplateSupplier, mode: 'preview' | 'download') {
  return {
    templateId: f.templateId,
    projectId: f.projectId || undefined,
    storeId: storePickApplies(supplier) ? f.storeId || undefined : undefined,
    dateFrom: f.dateFrom || undefined,
    dateTo: f.dateTo || undefined,
    pipelineStatus: f.pipelineStatus || undefined,
    handoffOnly: f.handoffOnly || undefined,
    reExport: f.reExport || undefined,
    ...(mode === 'preview' ? { preview: true, markExported: false } : { markExported: true }),
  }
}
