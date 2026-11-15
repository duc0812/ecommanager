import { describe, it, expect } from 'vitest'
import { fakeDrive } from './helpers/delivery-fake-drive'

describe('fakeDrive', () => {
  it('moveFile changes parents', async () => {
    const d = fakeDrive()
    d.addFile({ id: 'f1', parent: 'a', size: 5 })
    await d.moveFile('f1', 'b', 'x.psd')
    const info = await d.fileInfo('f1')
    expect(info?.parents).toEqual(['b'])
    expect(d.files.get('f1')?.name).toBe('x.psd')
  })

  it('fileInfo of an unknown id is null', async () => {
    expect(await fakeDrive().fileInfo('nope')).toBeNull()
  })

  it('records every call', async () => {
    const d = fakeDrive()
    d.addFile({ id: 'f1', parent: 'a', size: 5 })
    await d.fileInfo('f1')
    await d.moveFile('f1', 'b', 'n')
    await d.tidy('o1', 'l1')
    await d.taskFolder('o1', 'l1')
    await d.shareAnyoneReader('f1')
    expect(d.calls).toEqual(['fileInfo:f1', 'moveFile:f1', 'tidy:o1', 'taskFolder:o1', 'shareAnyoneReader:f1'])
  })

  it('shortcuts are findable and children list by parent', async () => {
    const d = fakeDrive()
    d.addFile({ id: 'f1', parent: 'a', size: 5 })
    const sc = await d.createShortcut('f1', 'p', 'n')
    expect(await d.findShortcut('p', 'f1')).toBe(sc)
    expect(await d.findShortcut('p', 'zz')).toBeNull()
    expect((await d.listChildren('p')).map(c => c.id)).toEqual([sc])
    await d.deleteFile(sc)
    expect(await d.listChildren('p')).toEqual([])
  })
})
