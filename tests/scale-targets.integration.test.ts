import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { prisma } from '@/lib/db'
import { DEFAULT_SCALE_SETTINGS, ScaleInputError, type ScaleDeps } from '@/lib/scale/settings'
import { readScaleFile, resolveScaleFile, scaleRoot } from '@/lib/scale/storage'
import { createTarget, createView, deleteTarget, deleteView, imageInput, listTargets, setViewBlank, staffTargetView, suggestViewDescription, targetView, updateTarget, updateView } from '@/lib/scale/targets'

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const JPG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACv/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q=='

function fakeDeps() {
  const log: any[] = []
  const deps: ScaleDeps = {
    image: null,
    vision: { describe: async (p: any) => { log.push(p); return { blankDescription: 'unworn hoodie, front view.', unprintedParts: 'The ribbing' } as any } },
    settings: DEFAULT_SCALE_SETTINGS,
    visionModel: 'gpt-6.1-sol',
    fetchImpl: fetch,
  }
  return { deps, log }
}

let tmp: string
const clean = async () => {
  const mine = await prisma.scaleTarget.findMany({ where: { sku: { startsWith: 'TEST' } }, select: { id: true } })
  await prisma.scaleTargetView.deleteMany({ where: { targetId: { in: mine.map(t => t.id) } } })
  await prisma.scaleTarget.deleteMany({ where: { sku: { startsWith: 'TEST' } } })
}
const find = async (sku: string) => (await listTargets()).find(t => t.sku === sku)!

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'scale-targets-'))
  process.env.DESIGN_STORAGE_DIR = tmp
  await clean()
})
afterAll(async () => {
  await clean()
  await fs.rm(tmp, { recursive: true, force: true })
})

describe('scale targets', () => {
  it('ships the first 14 target products, none of them ready until views are added', async () => {
    const seeded = (await listTargets()).filter(t => t.id.startsWith('scale_'))
    expect(seeded).toHaveLength(14)
    expect(seeded[0]).toMatchObject({ sku: 'FEHOVN', views: [] })
    expect(await listTargets({ readyOnly: true })).toEqual([])
  })

  it('a target is ready only when it is on and every one of its views has a blank and a description', async () => {
    const t = await createTarget({ name: 'Test Hoodie', sku: 'TEST1' })
    await expect(createTarget({ name: 'Dup', sku: 'TEST1' })).rejects.toBeInstanceOf(ScaleInputError)
    await expect(updateTarget(t.id, { active: true })).rejects.toThrow('Cần ít nhất một góc có ảnh phôi và mô tả trước khi bật')
    const front = await createView(t.id, { label: 'Mặt trước', side: 'front' })
    const back = await createView(t.id, { label: 'Mặt sau', side: 'back' })
    expect((await find('TEST1')).views.map(v => v.label)).toEqual(['Mặt trước', 'Mặt sau'])
    await expect(createView(t.id, { label: 'x', side: 'left' as any })).rejects.toBeInstanceOf(ScaleInputError)

    expect((await setViewBlank(front.id, PNG)).blankFile).toBe('blank.png')
    expect((await setViewBlank(front.id, JPG)).blankFile).toBe('blank.jpg')
    expect(await fs.readdir(path.join(scaleRoot(), 'views', front.id))).toEqual(['blank.jpg'])
    await expect(setViewBlank(front.id, 'data:text/plain;base64,aGk=')).rejects.toBeInstanceOf(ScaleInputError)
    await updateView(front.id, { blankDescription: 'front view.', unprintedParts: 'The ribbing' })
    await expect(updateTarget(t.id, { active: true })).rejects.toBeInstanceOf(ScaleInputError)

    await setViewBlank(back.id, PNG)
    await updateView(back.id, { blankDescription: 'back view.' })
    await updateTarget(t.id, { active: true })
    const ready = await listTargets({ readyOnly: true })
    expect(ready.map(x => x.sku)).toEqual(['TEST1'])
    expect(targetView(ready[0]).ready).toBe(true)
  })

  it('gives staff only what the picker needs, never the blank descriptions', async () => {
    const view = staffTargetView(await find('TEST1'))
    expect(Object.keys(view).sort()).toEqual(['id', 'name', 'ready', 'sku', 'thumbs', 'updatedAt'])
    expect(view.thumbs).toHaveLength(2)
    expect(Object.keys(view.thumbs[0]).sort()).toEqual(['file', 'viewId'])
    expect(JSON.stringify(view)).not.toContain('front view.')
  })

  it('a target stops being ready when one of its views loses its description', async () => {
    const t = await find('TEST1')
    await updateView(t.views[1].id, { blankDescription: ' ' })
    expect(await listTargets({ readyOnly: true })).toEqual([])
    await updateView(t.views[1].id, { blankDescription: 'back view.' })
  })

  it('drafts a view description from its blank without saving it', async () => {
    const t = await find('TEST1')
    const { deps, log } = fakeDeps()
    expect(await suggestViewDescription(t.views[0].id, deps)).toEqual({ blankDescription: 'unworn hoodie, front view.', unprintedParts: 'The ribbing' })
    expect(log[0]).toMatchObject({ schemaName: 'scale_blank', model: 'gpt-6.1-sol' })
    expect(log[0].text).toContain('FRONT')
    expect(log[0].images[0].startsWith('data:image/jpeg;base64,')).toBe(true)
    expect((await find('TEST1')).views[0].blankDescription).toBe('front view.')
    await expect(suggestViewDescription(t.views[0].id, { ...deps, vision: null })).rejects.toThrow('Chưa có API key Kie cho bước đọc ảnh')
  })

  it('asks the image model for the configured portrait shape when the model offers it, square otherwise', () => {
    const form = (ratios: string[]) => ({ promptField: 'prompt', imageField: 'input_urls', imageIsArray: true, options: [{ name: 'aspect_ratio', values: ratios, required: true }, { name: 'resolution', values: ['1K', '2K'], required: false }] })
    expect(imageInput(form(['1:1', '2:3']), 'p', ['a', 'b'], '2K', '2:3')).toMatchObject({ prompt: 'p', input_urls: ['a', 'b'], aspect_ratio: '2:3', resolution: '2K' })
    expect(imageInput(form(['1:1', '16:9']), 'p', ['a'], '2K', '2:3')).toMatchObject({ aspect_ratio: '1:1' })
  })

  it('only serves whitelisted file names from inside the scale folder', () => {
    expect(resolveScaleFile('jobs', '..', 'out.png')).toBeNull()
    expect(resolveScaleFile('jobs', 'abc123', '../../x.png')).toBeNull()
    expect(resolveScaleFile('other', 'abc123', 'out.png')).toBeNull()
    expect(resolveScaleFile('jobs', 'abc123', 'part-1.png')).toBe(path.resolve(scaleRoot(), 'jobs', 'abc123', 'part-1.png'))
    expect(resolveScaleFile('views', 'abc123', 'blank.jpg')).toBe(path.resolve(scaleRoot(), 'views', 'abc123', 'blank.jpg'))
  })

  it('deleting a view or a target removes its rows and files', async () => {
    const t = await find('TEST1')
    const [front, back] = t.views
    await deleteView(back.id)
    expect(await readScaleFile('views', back.id, 'blank.png')).toBeNull()
    expect((await find('TEST1')).views).toHaveLength(1)
    await deleteTarget(t.id)
    expect(await prisma.scaleTarget.findUnique({ where: { id: t.id } })).toBeNull()
    expect(await prisma.scaleTargetView.count({ where: { targetId: t.id } })).toBe(0)
    await expect(fs.stat(path.join(scaleRoot(), 'views', front.id))).rejects.toThrow()
  })
})
