import { describe, it, expect } from 'vitest'
import {
  cleanPartLabel, currentFileIds, currentFiles, driveFileName, driveOldFileName, extraPrintParts, fileKindOf, folderHoldsPrintFiles, missingPrintAreas,
  orderedPrintFiles, outdatedParts, partForUpload, partLabelFromFileName, partTaken, printFilesReady, resolvePartLabel,
} from '@/lib/task-files'

const file = (id: string, kind: string, printArea: string, version = 1, extra: Record<string, unknown> = {}) =>
  ({ id, kind, printArea, version, storage: 'DRIVE', drivePlace: 'TASK', removedAt: null, ...extra })

describe('part labels', () => {
  it('reads the part from the file name without its extension', () => {
    expect(partLabelFromFileName('front.png')).toBe('front')
    expect(partLabelFromFileName('C:\\Users\\me\\Tay áo trái.final.PSD')).toBe('Tay áo trái.final')
    expect(partLabelFromFileName('  back   side .png')).toBe('back side')
    expect(partLabelFromFileName('noext')).toBe('noext')
  })
  it('falls back to "Artwork" for an empty name and cuts at 60 characters', () => {
    expect(partLabelFromFileName('.png')).toBe('Artwork')
    expect(partLabelFromFileName('   .jpg')).toBe('Artwork')
    expect(partLabelFromFileName(`${'a'.repeat(70)}.png`)).toBe('a'.repeat(60))
    expect(cleanPartLabel('a/b\\c\n')).toBe('a b c')
  })
  it('joins a template area first, then an existing part, whatever the case', () => {
    expect(resolvePartLabel('front', ['Front', 'Back'], ['front'])).toBe('Front')
    expect(resolvePartLabel('SLEEVE', ['Front'], ['Sleeve'])).toBe('Sleeve')
    expect(resolvePartLabel('collar', ['Front'], ['Sleeve'])).toBe('collar')
    expect(partTaken('front', ['Back', 'FRONT'])).toBe(true)
    expect(partTaken('front', ['Back'])).toBe(false)
  })
  it('treats anything that is not MOCKUP as a print file', () => {
    expect(fileKindOf('MOCKUP')).toBe('MOCKUP')
    expect(fileKindOf(undefined)).toBe('PRINT')
    expect(fileKindOf('other')).toBe('PRINT')
  })
})

describe('current files', () => {
  const files = [
    file('f1', 'PRINT', 'Front', 1), file('f2', 'PRINT', 'Front', 2), file('s1', 'PRINT', 'sleeve'), file('c1', 'PRINT', 'Collar'),
    file('mf', 'MOCKUP', 'Front'), file('ml1', 'MOCKUP', 'Look', 1), file('ml2', 'MOCKUP', 'Look', 2),
  ]
  it('takes the newest version of each part, one kind at a time', () => {
    expect(currentFiles(files, 'PRINT').map(f => f.id)).toEqual(['c1', 'f2', 's1'])
    expect(currentFiles(files, 'MOCKUP').map(f => f.id)).toEqual(['mf', 'ml2'])
    expect(Array.from(currentFileIds(files)).sort()).toEqual(['c1', 'f2', 'mf', 'ml2', 's1'])
  })
  it('a removed newest version makes the one before it current again', () => {
    const withRemoved = files.map(f => (f.id === 'f2' ? { ...f, removedAt: new Date() } : f))
    expect(currentFileIds(withRemoved).has('f1')).toBe(true)
    expect(currentFileIds(withRemoved).has('f2')).toBe(false)
  })
  it('orders print files: template areas in template order, then the rest by name', () => {
    expect(orderedPrintFiles(files, ['Back', 'Front']).map(f => f.id)).toEqual(['f2', 'c1', 's1'])
    expect(orderedPrintFiles(files, ['sleeve', 'Front']).map(f => f.id)).toEqual(['s1', 'f2', 'c1'])
    expect(orderedPrintFiles(files, []).map(f => f.id)).toEqual(['c1', 'f2', 's1'])
    expect(extraPrintParts(files, ['Front'])).toEqual(['Collar', 'sleeve'])
  })
  it('a template needs every area; no template needs one print file; a mockup never counts', () => {
    expect(missingPrintAreas(files, ['Front', 'Back'])).toEqual(['Back'])
    expect(printFilesReady(files, ['Front', 'Back'])).toBe(false)
    expect(printFilesReady(files, ['Front'])).toBe(true)
    expect(printFilesReady([file('m', 'MOCKUP', 'Back')], ['Back'])).toBe(false)
    expect(printFilesReady([], [])).toBe(false)
    expect(printFilesReady([file('m', 'MOCKUP', 'x')], [])).toBe(false)
    expect(printFilesReady([file('p', 'PRINT', 'x')], [])).toBe(true)
  })
})

describe('names inside the task folder', () => {
  it('names a print file after its part and a mockup with the MOCKUP_ prefix', () => {
    expect(driveFileName({ kind: 'PRINT', printArea: 'front', fileName: 'front.png' })).toBe('front.png')
    expect(driveFileName({ kind: 'PRINT', printArea: 'Front', fileName: 'LIT4545_1_Front_auto.png' })).toBe('Front.png')
    expect(driveFileName({ kind: 'MOCKUP', printArea: 'look', fileName: 'look.JPG' })).toBe('MOCKUP_look.jpg')
    expect(driveFileName({ kind: 'PRINT', printArea: 'Tay áo: trái/phải', fileName: 'x.psd' })).toBe('Tay áo_ trái_phải.psd')
    expect(driveFileName({ kind: 'PRINT', printArea: 'front.png', fileName: 'whatever.png' })).toBe('front.png')
  })
  it('an old version carries its version number', () => {
    expect(driveOldFileName({ kind: 'PRINT', printArea: 'front', fileName: 'front.png', version: 3 })).toBe('v3_front.png')
    expect(driveOldFileName({ kind: 'MOCKUP', printArea: 'look', fileName: 'look.png', version: 1 })).toBe('v1_MOCKUP_look.png')
  })
})

describe('folderHoldsPrintFiles', () => {
  it('is true only when every current print file sits in the folder and nothing stale does', () => {
    expect(folderHoldsPrintFiles([file('a', 'PRINT', 'front'), file('b', 'PRINT', 'back')])).toBe(true)
    expect(folderHoldsPrintFiles([])).toBe(false)
    expect(folderHoldsPrintFiles([file('m', 'MOCKUP', 'look')])).toBe(false)
    expect(folderHoldsPrintFiles([file('a', 'PRINT', 'front'), file('b', 'PRINT', 'back', 1, { storage: 'LOCAL', drivePlace: null })])).toBe(false)
    expect(folderHoldsPrintFiles([file('a', 'PRINT', 'front', 1, { drivePlace: null })])).toBe(false)
    expect(folderHoldsPrintFiles([file('a', 'PRINT', 'front', 1, { drivePlace: 'STUCK' })])).toBe(false)
  })
  it('a mockup still on the server does not hold the folder link back', () => {
    expect(folderHoldsPrintFiles([file('a', 'PRINT', 'front'), file('m', 'MOCKUP', 'look', 1, { storage: 'LOCAL', drivePlace: null })])).toBe(true)
  })
  it('an old or removed Drive file must be in _old first', () => {
    const v2 = file('a2', 'PRINT', 'front', 2)
    expect(folderHoldsPrintFiles([file('a1', 'PRINT', 'front', 1, { drivePlace: 'OLD' }), v2])).toBe(true)
    expect(folderHoldsPrintFiles([file('a1', 'PRINT', 'front', 1), v2])).toBe(false)
    expect(folderHoldsPrintFiles([file('a1', 'PRINT', 'front', 1, { drivePlace: null }), v2])).toBe(false)
    expect(folderHoldsPrintFiles([file('a1', 'PRINT', 'front', 1, { storage: 'LOCAL', drivePlace: null }), v2])).toBe(true)
    expect(folderHoldsPrintFiles([v2, file('x', 'PRINT', 'gone', 1, { removedAt: new Date() })])).toBe(false)
    expect(folderHoldsPrintFiles([v2, file('x', 'PRINT', 'gone', 1, { removedAt: new Date(), drivePlace: 'OLD' })])).toBe(true)
  })
})

describe('partForUpload', () => {
  it('same name and type is the next version of that part', () => {
    expect(partForUpload('front.png', [], [{ printArea: 'Front', fileName: 'Front.png' }])).toBe('Front')
  })
  it('same name but another type becomes its own part, so a PSD never replaces the PNG', () => {
    expect(partForUpload('front.psd', [], [{ printArea: 'front', fileName: 'front.png' }])).toBe('front.psd')
    expect(partForUpload('front.psd', [], [{ printArea: 'front.psd', fileName: 'front.psd' }, { printArea: 'front', fileName: 'front.png' }])).toBe('front.psd')
  })
  it('a template area keeps its file when a source file with the same name arrives', () => {
    expect(partForUpload('Front.psd', ['Front'], [{ printArea: 'Front', fileName: 'Front.png' }])).toBe('Front.psd')
    expect(partForUpload('front.png', ['Front'], [])).toBe('Front')
  })
  it('uses the newest file of the part to compare types', () => {
    expect(partForUpload('front.png', [], [{ printArea: 'front', fileName: 'front.png' }, { printArea: 'front', fileName: 'front.jpg' }])).toBe('front')
  })
})

describe('outdatedParts', () => {
  const at = (printArea: string, day: number) => ({ printArea, createdAt: new Date(Date.UTC(2026, 9, day)) })

  it('retires a set named after its files once the template sheet arrives', () => {
    const files = [at('LIT5217_1 - front', 24), at('LIT5217_1 - back', 24), at('FRONT', 28), at('FRONT', 29)]
    expect(outdatedParts(files, ['FRONT'])).toEqual(['LIT5217_1 - back', 'LIT5217_1 - front'])
  })
  it('retires the default part next to the template area', () => {
    expect(outdatedParts([at('Artwork', 23), at('Print', 26)], ['Print'])).toEqual(['Artwork'])
  })
  it('keeps a part added after the template files', () => {
    expect(outdatedParts([at('Print', 26), at('reference', 27)], ['Print'])).toEqual([])
  })
  it('keeps a part re-uploaded after the template files, even if it started earlier', () => {
    expect(outdatedParts([at('extra', 20), at('Print', 26), at('extra', 27)], ['Print'])).toEqual([])
  })
  it('keeps a source file named after an area', () => {
    expect(outdatedParts([at('FRONT.psd', 20), at('front', 26)], ['FRONT'])).toEqual([])
  })
  it('does nothing before a template area has a file, or without a template', () => {
    expect(outdatedParts([at('front', 20), at('back', 21)], ['FRONT SHEET'])).toEqual([])
    expect(outdatedParts([at('front', 20), at('back', 21)], [])).toEqual([])
  })
})
