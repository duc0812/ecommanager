import { describe, it, expect } from 'vitest'
import { parseSheetUrl, parseSheetCsv, csvExportUrl } from './parse-sheet'

describe('parseSheetUrl', () => {
  it('extracts id and gid from an edit URL with #gid', () => {
    expect(parseSheetUrl('https://docs.google.com/spreadsheets/d/1abjXYZ/edit?gid=1162194966#gid=1162194966'))
      .toEqual({ spreadsheetId: '1abjXYZ', gid: '1162194966' })
  })
  it('gid is null when absent (do NOT default to 0 — a deleted first tab has no gid 0)', () => {
    expect(parseSheetUrl('https://docs.google.com/spreadsheets/d/1abjXYZ/edit?usp=sharing'))
      .toEqual({ spreadsheetId: '1abjXYZ', gid: null })
  })
  it('returns null for a non-sheets URL', () => {
    expect(parseSheetUrl('https://example.com/foo')).toBeNull()
  })
})

describe('csvExportUrl', () => {
  it('builds the export URL with a gid', () => {
    expect(csvExportUrl({ spreadsheetId: '1abjXYZ', gid: '5' }))
      .toBe('https://docs.google.com/spreadsheets/d/1abjXYZ/export?format=csv&gid=5')
  })
  it('omits gid when null (Google exports the first sheet)', () => {
    expect(csvExportUrl({ spreadsheetId: '1abjXYZ', gid: null }))
      .toBe('https://docs.google.com/spreadsheets/d/1abjXYZ/export?format=csv')
  })
})

describe('parseSheetCsv', () => {
  it('parses header + rows, keeps order token verbatim', () => {
    const rows = parseSheetCsv('Order Number,Tracking\n#LIT2225,UL083878160YP\n#LIT2226,UL090561681YP\n')
    expect(rows).toEqual([
      { orderToken: '#LIT2225', tracking: 'UL083878160YP' },
      { orderToken: '#LIT2226', tracking: 'UL090561681YP' },
    ])
  })
  it('falls back to first/last column when no header', () => {
    expect(parseSheetCsv('#LIT1,AA\n#LIT2,BB\n')).toEqual([
      { orderToken: '#LIT1', tracking: 'AA' },
      { orderToken: '#LIT2', tracking: 'BB' },
    ])
  })
  it('skips blank rows, empty tracking, and duplicates', () => {
    const rows = parseSheetCsv('Order,Tracking\n#LIT1,AA\n\n#LIT2,\n#LIT1,AA\n')
    expect(rows).toEqual([{ orderToken: '#LIT1', tracking: 'AA' }])
  })
})
