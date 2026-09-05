import { describe, it, expect } from 'vitest'
import { parseSheetUrl, parseSheetCsv, csvExportUrl } from './parse-sheet'

describe('parseSheetUrl', () => {
  it('extracts id and gid from an edit URL with #gid', () => {
    expect(parseSheetUrl('https://docs.google.com/spreadsheets/d/1abjXYZ/edit?gid=1162194966#gid=1162194966'))
      .toEqual({ spreadsheetId: '1abjXYZ', gid: '1162194966' })
  })
  it('defaults gid to 0 when absent', () => {
    expect(parseSheetUrl('https://docs.google.com/spreadsheets/d/1abjXYZ/edit'))
      .toEqual({ spreadsheetId: '1abjXYZ', gid: '0' })
  })
  it('returns null for a non-sheets URL', () => {
    expect(parseSheetUrl('https://example.com/foo')).toBeNull()
  })
})

describe('csvExportUrl', () => {
  it('builds the export URL', () => {
    expect(csvExportUrl({ spreadsheetId: '1abjXYZ', gid: '5' }))
      .toBe('https://docs.google.com/spreadsheets/d/1abjXYZ/export?format=csv&gid=5')
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
