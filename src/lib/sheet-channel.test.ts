import { describe, expect, it } from 'vitest'
import { DAY_SEPARATOR_COLOR, buildRow, collectKeys, columnLetter, enabledChannelFor, hasLine, lastDataRow, mapColumns, parseSheetChannels, planRows, rowKeys, sameRow, sheetDate, sizeLabel, tabNameFor, type SheetChannel } from '@/lib/sheet-channel'

describe('sheet dates', () => {
  it('uses the Vietnam day and no leading zero', () => {
    expect(sheetDate(new Date('2026-11-04T17:30:00Z'))).toBe('11/5/2026')
    expect(tabNameFor('ORDER {M}-{YYYY}', new Date('2026-11-04T17:30:00Z'))).toBe('ORDER 11-2026')
  })

  it('turns the month on the Vietnam clock', () => {
    expect(tabNameFor('ORDER {M}-{YYYY}', new Date('2026-11-30T17:30:00Z'))).toBe('ORDER 12-2026')
  })

  it('steps back across a year', () => {
    expect(tabNameFor('ORDER {M}-{YYYY}', new Date('2027-01-15T00:00:00Z'), 1)).toBe('ORDER 12-2026')
    expect(tabNameFor('ORDER {M}-{YYYY}', new Date('2027-01-15T00:00:00Z'), 2)).toBe('ORDER 11-2026')
  })
})

describe('row keys', () => {
  it.each([
    ['#LIT123', 'LIT123-1', 'LIT123_1'],
    ['#LIT123_1', 'LIT123', 'LIT123_1'],
    ['#LIT123', 'LIT123_1', 'LIT123_1'],
    ['#LIT123_1', 'LIT123-1', 'LIT123_1'],
  ])('reads %s + %s as one line', (a, b, key) => {
    const keys = collectKeys([{ orderNumber: a, vendor: b }])
    expect(hasLine(keys, key)).toBe(true)
    expect(hasLine(keys, 'LIT123_2')).toBe(false)
  })

  it('treats a row with no line suffix as the whole order', () => {
    expect(rowKeys('#LIT123', 'LIT123')).toEqual({ lines: [], orders: ['LIT123', 'LIT123'] })
    const keys = collectKeys([{ orderNumber: '#LIT123', vendor: 'LIT123' }])
    expect(hasLine(keys, 'LIT123_1')).toBe(true)
    expect(hasLine(keys, 'LIT123_9')).toBe(true)
    expect(hasLine(keys, 'LIT124_1')).toBe(false)
  })

  it('keeps a redo apart from the line it redoes', () => {
    const keys = collectKeys([{ orderNumber: '#LIT123_1', vendor: 'LIT123' }])
    expect(hasLine(keys, 'LIT123_1R')).toBe(false)
    expect(hasLine(collectKeys([{ orderNumber: '#LIT123_1R', vendor: 'LIT123R' }]), 'LIT123_1')).toBe(false)
  })

  it('ignores blank rows and case', () => {
    expect(rowKeys('', '')).toEqual({ lines: [], orders: [] })
    expect(hasLine(collectKeys([{ orderNumber: '#lit123_1', vendor: '' }]), 'LIT123_1')).toBe(true)
  })
})

describe('columns', () => {
  const columns = [{ position: 'A', source: 'order.sentDate' }, { header: 'Order Number', source: 'x' }, { header: 'Custom Name', source: 'y' }]

  it('finds a column by name wherever it moved, ignoring spaces and case', () => {
    expect(mapColumns(['       ', 'x', 'ORDER NUMBER ', 'custom name'], columns)).toEqual({ indexes: [0, 2, 3], missing: [] })
  })

  it('names the column that is gone', () => {
    expect(mapColumns(['', 'Order Number'], columns).missing).toEqual(['Custom Name'])
  })

  it('leaves every unmapped cell empty', () => {
    expect(buildRow([0, 3], ['a', 'b'])).toEqual(['a', '', '', 'b'])
  })

  it('compares a read-back row, trimming spaces', () => {
    expect(sameRow(['a', '', 'b'], ['a ', '', 'b'])).toBe(true)
    expect(sameRow(['a', '', 'b'], ['a'])).toBe(false)
  })

  it('writes column letters past Z', () => {
    expect(columnLetter(0)).toBe('A')
    expect(columnLetter(27)).toBe('AB')
  })
})

describe('size', () => {
  it.each([
    ['L', 'Baseball Jersey / L', 'L'],
    ['Kid 8Y', 'Kid 8Y', 'Kid 8Y'],
    ['40oz', '40oz / Black', '40oz'],
    ['Classic Cap', 'Classic Cap', 'Classic Cap'],
    ['Pullover Hoodie', 'Pullover Hoodie / Orange / XL', 'XL'],
    ['Zip Hoodie', 'Zip Hoodie, Black / 2XL', '2XL'],
    ['Full Set', 'Full Set / L', 'Full Set / L'],
    ['Only Pants', 'Only Pants / M', 'Only Pants / M'],
    ['Crewneck', 'Crewneck / XL', 'XL'],
    ['S', 'Leather Handbag / S', 'S'],
    [null, 'Black', ''],
    [null, null, ''],
    ['Full Set', 'Full Set', 'Full Set'],
  ])('%s + %s gives %s', (blank, title, want) => {
    expect(sizeLabel(blank, title)).toBe(want)
  })
})

describe('channels', () => {
  const channel: SheetChannel = { supplierCode: 'jomall', enabled: true, spreadsheetId: 's', tabPattern: 'T', columns: [] }

  it('finds only an enabled channel, by code', () => {
    expect(enabledChannelFor([channel], { code: ' JOMALL ' })).toBe(channel)
    expect(enabledChannelFor([{ ...channel, enabled: false }], { code: 'jomall' })).toBeNull()
    expect(enabledChannelFor([channel], { code: 'mango' })).toBeNull()
  })

  it('survives a broken setting', () => {
    expect(parseSheetChannels('not json')).toEqual([])
    expect(parseSheetChannels('[{"supplierCode":"x"}]')).toEqual([])
    expect(parseSheetChannels(null)).toEqual([])
  })

  it('takes a channel that names no store', () => {
    expect(parseSheetChannels(JSON.stringify([{ supplierCode: 'jomall', enabled: true, spreadsheetId: 's', tabPattern: 'T', columns: [] }]))).toEqual([channel])
  })

  it('reads a stored channel that still has storeShop, drops the field and does not hand it back', () => {
    const stored = JSON.stringify([{ supplierCode: 'jomall', enabled: true, spreadsheetId: 's', tabPattern: 'T', storeShop: 'caramiaus-store.myshopify.com', columns: [{ header: 'SKU', source: 'line.sku' }] }])
    const [parsed] = parseSheetChannels(stored)
    expect(parsed).toEqual({ supplierCode: 'jomall', enabled: true, spreadsheetId: 's', tabPattern: 'T', columns: [{ header: 'SKU', source: 'line.sku' }] })
    expect('storeShop' in parsed).toBe(false)
    expect(JSON.stringify(parseSheetChannels(JSON.stringify(parsed)))).not.toContain('storeShop')
  })
})

describe('where a send goes', () => {
  const WHITE = { red: 1, green: 1, blue: 1 }

  it('goes past the green day row already waiting: last data 166, green 167, writes at 168', () => {
    expect(planRows({ lastRow: 166, lastDate: '10/29/2026', today: '11/5/2026', colors: [DAY_SEPARATOR_COLOR, null, null] })).toEqual({ separatorRow: null, startRow: 168 })
  })

  it('goes straight under the last row on the same day', () => {
    expect(planRows({ lastRow: 170, lastDate: '11/5/2026', today: '11/5/2026', colors: [null, null, null] })).toEqual({ separatorRow: null, startRow: 171 })
    expect(planRows({ lastRow: 170, lastDate: '11/5/2026', today: '11/5/2026', colors: [WHITE, WHITE, null] })).toEqual({ separatorRow: null, startRow: 171 })
  })

  it('adds the day row on the first send of a new day', () => {
    expect(planRows({ lastRow: 170, lastDate: '11/4/2026', today: '11/5/2026', colors: [null, null, null] })).toEqual({ separatorRow: 171, startRow: 172 })
  })

  it('adds no day row under the header of an empty tab', () => {
    expect(planRows({ lastRow: 1, lastDate: '', today: '11/5/2026', colors: [null] })).toEqual({ separatorRow: null, startRow: 2 })
  })

  it('finds the last row with data, past empty rows between days and trailing blanks', () => {
    expect(lastDataRow([['h'], ['a'], [], ['b'], ['  ', ''], []])).toBe(4)
    expect(lastDataRow([])).toBe(0)
  })
})
