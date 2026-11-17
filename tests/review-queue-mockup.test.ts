import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { builderOf, customValues, designCodeOf, hasLibrary, loadRegistry, resolveMockup, sizeOz } from '../scripts/review-queue/mockup.mjs'

describe('custom helpers', () => {
  it('customValues keeps only what the shopper typed', () => {
    expect(customValues([
      { name: 'Custom Name Yes or No', value: 'Yes' }, { name: 'Custom Name', value: ' Grace ' }, { name: '_pers', value: 'abc' },
      { name: 'Enter Number', value: '' }, { name: 'Back', value: 'No' }, { name: 'Choose Color', value: 'Option 1' },
    ])).toEqual([{ name: 'Custom Name', value: 'Grace' }, { name: 'Choose Color', value: 'Option 1' }])
    expect(customValues(undefined)).toEqual([])
  })
  it('builderOf reads the builder from the raw attributes', () => {
    expect(builderOf([{ key: 'Custom Name', value: 'Kate' }, { key: '_pers', value: 'mw4midg6kthh' }])).toBe('pers')
    expect(builderOf([{ key: '_design', value: '{"v":"cm1","artwork":"x"}' }])).toBe('cm1')
    expect(builderOf([{ key: '_design', value: '{"v":"other"}' }])).toBe('design')
    expect(builderOf([{ key: '_customall_preview', value: 'https://x' }])).toBeNull()
    expect(builderOf(null)).toBeNull()
  })
  it('sizeOz and designCodeOf', () => {
    expect(sizeOz('DN1610261054-OVERSEAS, 40OZ', 'Overseas / 40oz')).toBe('40')
    expect(sizeOz('DN1610261054-US', 'US / 20oz(No handle)')).toBe('20')
    expect(sizeOz('TN1-XL', 'XL')).toBeNull()
    expect(designCodeOf('TN2605261712-Turquoise')).toBe('TN2605261712')
    expect(designCodeOf('dn1710260259, GRY')).toBe('DN1710260259')
    expect(designCodeOf('REMI-CUSTOM')).toBeNull()
    expect(designCodeOf(null)).toBeNull()
  })
})

describe('resolveMockup', () => {
  let tmp: string
  let root: string
  let outDir: string
  let calls: { args: string[], cwd: string }[]
  const size = async () => ({ widthPx: 1254, heightPx: 1254 })
  const info = (over: any = {}) => ({ taskKey: 'LIT7001_1', sku: 'DN1610261054-OVERSEAS, 40OZ', variantTitle: 'Overseas / 40oz', custom: [{ name: 'Custom Name', value: 'Lindarella' }], builder: 'pers', customerPreviewUrl: null, prodMockup: false, storeImage: null, ...over })
  const run = (write: (out: string) => void, stdout = '', code = 0) => async (args: string[], { cwd }: any) => {
    calls.push({ args, cwd })
    const i = args.indexOf('--out')
    const out = i >= 0 ? args[i + 1] : args[args.length - 1]
    if (code === 0) write(out)
    return { code, stdout, stderr: code ? 'Traceback: boom' : '' }
  }
  const writeJpg = (out: string) => { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, 'JPG') }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rq-mock-'))
    root = path.join(tmp, 'ab')
    outDir = path.join(tmp, 'out')
    calls = []
    fs.mkdirSync(path.join(root, 'mockups'), { recursive: true })
    fs.writeFileSync(path.join(root, 'mockups', 'auto-mockup.json'), JSON.stringify({ _note: 'x', DN1610261054: { tool: 'hapo', field: 'Custom Name' } }))
    fs.mkdirSync(path.join(root, 'TN2605261712', 'mockup'), { recursive: true })
    fs.writeFileSync(path.join(root, 'TN2605261712', 'mockup', 'mockup.json'), '{"design":"TN2605261712","base":"sku-tail","texts":[]}')
  })

  it('registry and library lookups tolerate a missing file', () => {
    expect(loadRegistry(root).DN1610261054).toEqual({ tool: 'hapo', field: 'Custom Name' })
    expect(loadRegistry(path.join(tmp, 'nope'))).toEqual({})
    expect(hasLibrary(root, 'TN2605261712')).toBe(true)
    expect(hasLibrary(root, 'TN0000000000')).toBe(false)
    expect(hasLibrary(root, null)).toBe(false)
  })

  it('a mockup in the push, on prod, or the shopper preview needs no file', async () => {
    expect(await resolveMockup({ info: info(), hasMockupFile: true, outDir, root, run: run(writeJpg) })).toMatchObject({ state: 'present' })
    expect(await resolveMockup({ info: info({ prodMockup: true }), hasMockupFile: false, outDir, root, run: run(writeJpg) })).toMatchObject({ state: 'prod' })
    expect(await resolveMockup({ info: info({ customerPreviewUrl: 'https://assets-v2.customall.io/x.png' }), hasMockupFile: false, outDir, root, run: run(writeJpg) })).toMatchObject({ state: 'preview' })
    expect(calls).toEqual([])
  })

  it('a HaPo tumbler builder line is redrawn by hapo_render.py with its size and name', async () => {
    const r = await resolveMockup({ info: info(), hasMockupFile: false, outDir, root, run: run(writeJpg), size })
    expect(r.state).toBe('hapo')
    expect(r.file).toMatchObject({ kind: 'MOCKUP', printArea: 'Preview Lindarella', fileName: 'LIT7001_1_Preview_Lindarella.jpg', mimeType: 'image/jpeg', widthPx: 1254, heightPx: 1254 })
    expect(fs.readFileSync(r.file!.path, 'utf8')).toBe('JPG')
    expect(path.dirname(r.file!.path)).toBe(outDir)
    expect(calls).toHaveLength(1)
    expect(calls[0].cwd).toBe(path.join(root, 'mockups'))
    expect(calls[0].args.slice(0, 3)).toEqual([path.join(root, 'mockups', 'hapo_render.py'), '40', 'Lindarella'])
  })

  it('hapo without a size, without a name, or failing → missing with the reason', async () => {
    expect(await resolveMockup({ info: info({ sku: 'DN1610261054', variantTitle: 'US' }), hasMockupFile: false, outDir, root, run: run(writeJpg) })).toMatchObject({ state: 'missing', reason: expect.stringContaining('cỡ') })
    expect(await resolveMockup({ info: info({ custom: [{ name: 'Custom Name Yes or No', value: 'No' }] }), hasMockupFile: false, outDir, root, run: run(writeJpg) })).toMatchObject({ state: 'missing', reason: expect.stringContaining('không có tên') })
    const r = await resolveMockup({ info: info(), hasMockupFile: false, outDir, root, run: run(writeJpg, '', 1) })
    expect(r).toMatchObject({ state: 'missing', reason: expect.stringMatching(/hapo_render\.py lỗi \(exit 1\): .*boom/) })
    expect(r.file).toBeUndefined()
  })

  it('a design with a mockup library goes through lib_mock.py with the raw SKU, the custom and the variant title', async () => {
    const ok = JSON.stringify({ ok: true, path: 'x', base: 'PURPLE.png', widthPx: 1500, heightPx: 1500, name: 'Lori' })
    const r = await resolveMockup({
      info: info({ taskKey: 'LIT7025_1', sku: 'TN2605261712-Purple', variantTitle: 'Purple / M / Unisex', custom: [{ name: '_Custom Name: Yes Or No?', value: 'Yes' }, { name: 'Custom Name', value: 'Lori' }] }),
      hasMockupFile: false, outDir, root, run: run(writeJpg, `noise\n${ok}\n`), size,
    })
    expect(r).toMatchObject({ state: 'library', note: expect.stringContaining('PURPLE.png'), file: { kind: 'MOCKUP', printArea: 'Preview Lori', fileName: 'LIT7025_1_Preview_Lori.jpg' } })
    expect(calls[0].args).toEqual([path.join(root, 'mockups', 'lib_mock.py'), 'LIT7025_1', 'TN2605261712-Purple', 'Custom Name=Lori', '--variant', 'Purple / M / Unisex', '--out', r.file!.path])
    const bad = JSON.stringify({ ok: false, error: 'no plain base for TN2605261712-Turquoise (có: PINK.png)' })
    expect(await resolveMockup({ info: info({ sku: 'TN2605261712-Turquoise' }), hasMockupFile: false, outDir, root, run: run(writeJpg, bad, 2) }))
      .toMatchObject({ state: 'missing', reason: 'thư viện mockup TN2605261712: no plain base for TN2605261712-Turquoise (có: PINK.png)' })
  })

  it('a builder line without a recipe, or custom without a library, is missing; no custom falls back to the store photo', async () => {
    const r1 = await resolveMockup({ info: info({ sku: 'DN0310260203-KID, YOUTH-M' }), hasMockupFile: false, outDir, root, run: run(writeJpg) })
    expect(r1).toMatchObject({ state: 'missing', reason: expect.stringMatching(/builder \(pers\).*DN0310260203/) })
    const r2 = await resolveMockup({ info: info({ sku: 'SW15051522-XL', builder: null }), hasMockupFile: false, outDir, root, run: run(writeJpg) })
    expect(r2).toMatchObject({ state: 'missing', reason: expect.stringMatching(/Custom Name=Lindarella.*SW15051522/) })
    const store = path.join(tmp, 'store.jpg')
    fs.writeFileSync(store, 'STORE')
    const r3 = await resolveMockup({ info: info({ sku: 'SW15051522-XL', builder: null, custom: [{ name: 'Custom Name Yes Or No', value: 'No' }], storeImage: store }), hasMockupFile: false, outDir, root, run: run(writeJpg), size })
    expect(r3).toMatchObject({ state: 'store', file: { printArea: 'Preview no-name', fileName: 'LIT7001_1_Preview_no-name.jpg' } })
    expect(fs.readFileSync(r3.file!.path, 'utf8')).toBe('STORE')
    const r4 = await resolveMockup({ info: info({ sku: 'SW15051522-XL', builder: null, custom: [] }), hasMockupFile: false, outDir, root, run: run(writeJpg) })
    expect(r4).toMatchObject({ state: 'missing', reason: expect.stringContaining('ảnh biến thể') })
    expect(calls).toEqual([])
  })
})
