import { describe, expect, it } from 'vitest'
import { csvExportBody, storePickApplies, type CsvExportFilters } from '@/lib/csv-export-request'

const filters: CsvExportFilters = {
  templateId: 'tmpl-1', projectId: '', storeId: 'store-remi', dateFrom: '2026-10-01', dateTo: '2026-10-31',
  pipelineStatus: '', handoffOnly: false, reExport: false,
}
const PGPRINTS = { code: 'pgprints', apiType: null }
const JOMALL = { code: 'jomall', apiType: null }

describe('the CSV export request body', () => {
  it('a PGprints template sends the picked store', () => {
    expect(storePickApplies(PGPRINTS)).toBe(true)
    expect(storePickApplies({ code: 'pg-us', apiType: 'pgprints' })).toBe(true)
    expect(JSON.parse(JSON.stringify(csvExportBody(filters, PGPRINTS, 'preview')))).toEqual({
      templateId: 'tmpl-1', storeId: 'store-remi', dateFrom: '2026-10-01', dateTo: '2026-10-31', preview: true, markExported: false,
    })
    expect(JSON.parse(JSON.stringify(csvExportBody({ ...filters, storeId: null }, PGPRINTS, 'download')))).toEqual({
      templateId: 'tmpl-1', dateFrom: '2026-10-01', dateTo: '2026-10-31', markExported: true,
    })
  })

  it('any other template sends no store, whatever was picked on another page: the body from before stores could be picked', () => {
    expect(storePickApplies(JOMALL)).toBe(false)
    expect(storePickApplies(undefined)).toBe(false)
    const all = { ...filters, projectId: 'proj-1', pipelineStatus: 'READY_TO_PRODUCTION', handoffOnly: true, reExport: true }
    expect(JSON.stringify(csvExportBody(all, JOMALL, 'preview'))).toBe(JSON.stringify({
      templateId: 'tmpl-1', projectId: 'proj-1', dateFrom: '2026-10-01', dateTo: '2026-10-31', pipelineStatus: 'READY_TO_PRODUCTION',
      handoffOnly: true, reExport: true, preview: true, markExported: false,
    }))
    expect(JSON.stringify(csvExportBody(filters, JOMALL, 'download'))).toBe(JSON.stringify({
      templateId: 'tmpl-1', dateFrom: '2026-10-01', dateTo: '2026-10-31', markExported: true,
    }))
    expect(JSON.stringify(csvExportBody(filters, undefined, 'download'))).not.toContain('storeId')
  })
})
