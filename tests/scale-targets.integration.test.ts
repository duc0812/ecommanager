import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { prisma } from '@/lib/db'
import type { PollResult } from '@/lib/creative/kie'
import { DEFAULT_SCALE_SETTINGS, ScaleInputError, type ScaleDeps } from '@/lib/scale/settings'
import { readScaleFile, resolveScaleFile, scaleRoot } from '@/lib/scale/storage'
import { acceptCandidate, createTarget, deleteTarget, discardCandidate, listTargets, refreshCandidate, setBlank, startCandidate, suggestDescription, targetView, updateTarget } from '@/lib/scale/targets'

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const JPG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACv/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q=='
const editSchema = { type: 'object', required: ['prompt', 'input_urls', 'aspect_ratio'], properties: { prompt: { type: 'string' }, input_urls: { type: 'array', items: { type: 'string' } }, aspect_ratio: { type: 'string', enum: ['16:9', '1:1'] }, resolution: { type: 'string', enum: ['1K', '2K', '4K'] } } }
const downloadFetch = (async () => new Response(Buffer.from('candidate-bytes'), { status: 200, headers: { 'Content-Type': 'image/png' } })) as unknown as typeof fetch

function fakeDeps(polls: PollResult[] = [{ state: 'running' }]) {
  const log: any[] = []
  let pollIdx = 0
  const deps: ScaleDeps = {
    image: {
      schema: async () => ({ input: editSchema, root: {} }),
      uploadBase64: async (_d: string, name: string) => { log.push(['upload', name]); return `https://tempfile.redpandaai.co/${name}` },
      createTask: async (model: string, input: Record<string, unknown>) => { log.push(['create', model, input]); return 'task-9' },
      poll: async () => polls[Math.min(pollIdx++, polls.length - 1)],
    },
    vision: { describe: async (p: any) => { log.push(['vision', p]); return { blankDescription: 'front view on the left, back view on the right.', unprintedParts: 'The ribbing and zipper' } as any } },
    settings: DEFAULT_SCALE_SETTINGS,
    visionModel: 'gpt-6.1-sol',
    fetchImpl: downloadFetch,
  }
  return { deps, log }
}

let tmp: string
const clean = () => prisma.scaleTarget.deleteMany({ where: { sku: { startsWith: 'TEST' } } })

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
  it('ships the first 14 target products switched off', async () => {
    const seeded = (await listTargets()).filter(t => t.id.startsWith('scale_'))
    expect(seeded).toHaveLength(14)
    expect(seeded[0]).toMatchObject({ sku: 'FEHOVN', active: false, blankFile: null })
    expect(await listTargets({ readyOnly: true })).toEqual([])
  })

  it('a new target is not ready and cannot be switched on without a blank and a description', async () => {
    const t = await createTarget({ name: 'Test Hoodie', sku: 'TEST1' })
    expect(targetView(t).ready).toBe(false)
    await expect(updateTarget(t.id, { active: true })).rejects.toBeInstanceOf(ScaleInputError)
    await expect(createTarget({ name: 'Dup', sku: 'TEST1' })).rejects.toBeInstanceOf(ScaleInputError)
    await expect(createTarget({ name: ' ', sku: 'TEST0' })).rejects.toBeInstanceOf(ScaleInputError)
  })

  it('keeps one blank file per target and lists the target once it is complete and on', async () => {
    const t = await prisma.scaleTarget.findUniqueOrThrow({ where: { sku: 'TEST1' } })
    expect((await setBlank(t.id, PNG)).blankFile).toBe('blank.png')
    expect((await setBlank(t.id, JPG)).blankFile).toBe('blank.jpg')
    const dir = await fs.readdir(path.join(scaleRoot(), 'targets', t.id))
    expect(dir).toEqual(['blank.jpg'])
    await expect(setBlank(t.id, 'data:text/plain;base64,aGk=')).rejects.toBeInstanceOf(ScaleInputError)
    await updateTarget(t.id, { blankDescription: 'front left, back right.', unprintedParts: 'The ribbing', active: true })
    const ready = await listTargets({ readyOnly: true })
    expect(ready.map(x => x.sku)).toEqual(['TEST1'])
  })

  it('generates a blank candidate through the image model and accepts it as the blank', async () => {
    const t = await createTarget({ name: 'Test Bomber', sku: 'TEST2' })
    const { deps, log } = fakeDeps([{ state: 'running' }, { state: 'done', urls: ['https://tempfile.redpandaai.co/out.png'], credits: 8, costTime: null }])
    const started = await startCandidate(t.id, PNG, deps)
    expect(started).toMatchObject({ candidateStatus: 'running', candidateTaskId: 'task-9' })
    const create = log.find(l => l[0] === 'create')
    expect(create[1]).toBe('gpt-image-2-5-flare-image-to-image')
    expect(create[2].prompt).toContain('REMOVE ALL PRINTED ARTWORK')
    expect(create[2].input_urls).toHaveLength(1)
    expect(create[2]).toMatchObject({ aspect_ratio: '1:1', resolution: '2K' })
    expect((await refreshCandidate(t.id, deps)).candidateStatus).toBe('running')
    const ready = await refreshCandidate(t.id, deps)
    expect(ready).toMatchObject({ candidateStatus: 'ready', candidateFile: 'candidate.png' })
    const accepted = await acceptCandidate(t.id)
    expect(accepted).toMatchObject({ blankFile: 'blank.png', candidateFile: null, candidateStatus: null, candidateTaskId: null })
    expect((await readScaleFile('targets', t.id, 'blank.png'))?.bytes.toString()).toBe('candidate-bytes')
    expect(await readScaleFile('targets', t.id, 'candidate.png')).toBeNull()
  })

  it('records why a candidate failed and lets it be discarded', async () => {
    const t = await createTarget({ name: 'Test Cloak', sku: 'TEST3' })
    const { deps } = fakeDeps([{ state: 'failed', error: 'content policy' }])
    await startCandidate(t.id, PNG, deps)
    expect(await refreshCandidate(t.id, deps)).toMatchObject({ candidateStatus: 'failed', candidateError: 'content policy' })
    expect(await discardCandidate(t.id)).toMatchObject({ candidateStatus: null, candidateError: null })
    await expect(acceptCandidate(t.id)).rejects.toBeInstanceOf(ScaleInputError)
  })

  it('says which key lacks the image model when the candidate cannot start', async () => {
    const t = await createTarget({ name: 'Test Tee', sku: 'TEST4' })
    const { deps } = fakeDeps()
    deps.image!.createTask = async () => { throw new Error('kie createTask 401: The API key is not authorized to use this model.') }
    await expect(startCandidate(t.id, PNG, deps)).rejects.toThrow('Key Kie (Creative) chưa được cấp quyền model gpt-image-2-5-flare-image-to-image')
    await expect(startCandidate(t.id, PNG, { ...deps, image: null })).rejects.toThrow('Chưa có API key Kie cho bước tạo ảnh')
  })

  it('drafts the blank description from the blank image without saving it', async () => {
    const t = await prisma.scaleTarget.findUniqueOrThrow({ where: { sku: 'TEST1' } })
    const { deps, log } = fakeDeps()
    const out = await suggestDescription(t.id, deps)
    expect(out).toEqual({ blankDescription: 'front view on the left, back view on the right.', unprintedParts: 'The ribbing and zipper' })
    const call = log.find(l => l[0] === 'vision')[1]
    expect(call.schemaName).toBe('scale_blank')
    expect(call.model).toBe('gpt-6.1-sol')
    expect(call.images[0].startsWith('data:image/jpeg;base64,')).toBe(true)
    expect((await prisma.scaleTarget.findUniqueOrThrow({ where: { id: t.id } })).blankDescription).toBe('front left, back right.')
  })

  it('only serves whitelisted file names from inside the scale folder', () => {
    expect(resolveScaleFile('jobs', '..', 'out.png')).toBeNull()
    expect(resolveScaleFile('jobs', 'abc123', '../../x.png')).toBeNull()
    expect(resolveScaleFile('other', 'abc123', 'out.png')).toBeNull()
    expect(resolveScaleFile('targets', 'scale_fehovn', 'blank.png')).toBe(path.resolve(scaleRoot(), 'targets', 'scale_fehovn', 'blank.png'))
  })

  it('deleting a target removes its row and its files', async () => {
    const t = await prisma.scaleTarget.findUniqueOrThrow({ where: { sku: 'TEST2' } })
    await deleteTarget(t.id)
    expect(await prisma.scaleTarget.findUnique({ where: { id: t.id } })).toBeNull()
    await expect(fs.stat(path.join(scaleRoot(), 'targets', t.id))).rejects.toThrow()
  })
})
