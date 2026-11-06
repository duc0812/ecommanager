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

  describe('a sheet that writes the bare order number and the line key in Order Vendor (Mangoshao)', () => {
    const MANGO = 'Date,Order Number,Order Vendor,SKU,Tracking\n'

    it('reads the line key of the same order as the row token', () => {
      const rows = parseSheetCsv(`${MANGO}11/4/2026,#LIT5708,LIT5708_1,X,UL1\n11/4/2026,#LIT6000,#LIT6000_2,X,UL2\n11/4/2026,#LIT6000,lit6000_3,X,UL2\n`)
      expect(rows).toEqual([
        { orderToken: 'LIT5708_1', tracking: 'UL1', byOrderNumber: true },
        { orderToken: 'LIT6000_2', tracking: 'UL2', byOrderNumber: true },
        { orderToken: 'LIT6000_3', tracking: 'UL2', byOrderNumber: true },
      ])
    })

    it('keeps the bare order number when Order Vendor is empty, is no line key, or names another order', () => {
      const rows = parseSheetCsv(`${MANGO}11/4/2026,#LIT6001,LIT6002_1,X,UL3\n11/4/2026,#LIT6003,,X,UL4\n11/4/2026,#LIT6004,LIT6004,X,UL5\n11/4/2026,#LIT6005,LIT60051_1,X,UL6\n`)
      expect(rows).toEqual([
        { orderToken: '#LIT6001', tracking: 'UL3' },
        { orderToken: '#LIT6003', tracking: 'UL4' },
        { orderToken: '#LIT6004', tracking: 'UL5' },
        { orderToken: '#LIT6005', tracking: 'UL6' },
      ])
    })

    it('two lines of one order with one tracking stay two rows', () => {
      const rows = parseSheetCsv(`${MANGO}11/4/2026,#LIT7,LIT7_1,X,UL7\n11/4/2026,#LIT7,LIT7_2,X,UL7\n11/4/2026,#LIT7,LIT7_2,X,UL7\n`)
      expect(rows.map(r => r.orderToken)).toEqual(['LIT7_1', 'LIT7_2'])
    })
  })

  it('a Jomall row (line key in Order Number, bare order in Order Vendor) is read as before', () => {
    const rows = parseSheetCsv('Date,Order Number,Order Vendor,Tracking\n11/4/2026,#LIT7000_2,LIT7000,UL5\n11/4/2026,#LIT7001,LIT7001,UL6\n')
    expect(rows).toEqual([
      { orderToken: '#LIT7000_2', tracking: 'UL5' },
      { orderToken: '#LIT7001', tracking: 'UL6' },
    ])
  })
})
