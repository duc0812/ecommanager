import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { prisma } from '@/lib/db'
import { CreativeInputError, createJob, deleteJob, jobView, listJobs, refreshJob, type Providers } from '@/lib/creative/jobs'
import { creativeRoot, resolveFile } from '@/lib/creative/storage'
import type { PollResult } from '@/lib/creative/kie'

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

function fakeKie(opts: { schema: any; polls: PollResult[] }) {
  const log: any[] = []
  let pollIdx = 0
  return {
    log,
    client: {
      schema: async () => ({ input: opts.schema, root: {} }),
      uploadBase64: async (_dataUrl: string, name: string) => { log.push(['upload', name]); return `https://tempfile.redpandaai.co/${name}` },
      createTask: async (model: string, input: Record<string, unknown>) => { log.push(['create', model, input]); return 'task-1' },
      poll: async () => opts.polls[Math.min(pollIdx++, opts.polls.length - 1)],
      catalog: async () => [],
    } as any,
  }
}

const downloadFetch = (async (url: any) => new Response(Buffer.from('png-bytes-' + String(url)), { status: 200, headers: { 'Content-Type': 'image/png' } })) as unknown as typeof fetch
const brokenFetch = (async () => { throw new Error('ECONNRESET') }) as unknown as typeof fetch

const editSchema = { type: 'object', required: ['prompt', 'image_urls', 'aspect_ratio'], properties: { prompt: { type: 'string' }, image_urls: { type: 'array', items: { type: 'string' } }, aspect_ratio: { type: 'string', enum: ['1:1', '16:9'] } } }
const textSchema = { type: 'object', required: ['prompt'], properties: { prompt: { type: 'string' } } }

let tmp: string
beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'creative-test-'))
  process.env.DESIGN_STORAGE_DIR = tmp
  await prisma.creativeJob.deleteMany({})
})
afterAll(async () => {
  await prisma.creativeJob.deleteMany({})
  await fs.rm(tmp, { recursive: true, force: true })
})

describe('createJob', () => {
  it('stores the reference image, uploads it and submits the mapped input', async () => {
    const kie = fakeKie({ schema: editSchema, polls: [{ state: 'running' }] })
    const job = await createJob({ provider: 'kie', model: 'seedream/4.5-edit', prompt: 'make it blue', images: [{ dataUrl: PNG, name: 'cat.png' }], options: {}, userId: 'u1' }, { kie: kie.client })
    expect(job.status).toBe('running')
    expect(job.providerTaskId).toBe('task-1')
    expect(JSON.parse(job.refImages)).toEqual(['ref-0.png'])
    await expect(fs.stat(path.join(creativeRoot(), job.id, 'ref-0.png'))).resolves.toBeTruthy()
    expect(kie.log[0]).toEqual(['upload', 'ref-0.png'])
    expect(kie.log[1]).toEqual(['create', 'seedream/4.5-edit', { prompt: 'make it blue', image_urls: ['https://tempfile.redpandaai.co/ref-0.png'], aspect_ratio: '1:1' }])
    expect(JSON.parse(job.inputJson)).toEqual({ prompt: 'make it blue', image_urls: ['https://tempfile.redpandaai.co/ref-0.png'], aspect_ratio: '1:1' })
    expect(job.createdBy).toBe('u1')
  })

  it('rejects images for a text-only model with a Vietnamese message', async () => {
    const kie = fakeKie({ schema: textSchema, polls: [] })
    await expect(createJob({ provider: 'kie', model: 'qwen/text-to-image', prompt: 'p', images: [{ dataUrl: PNG, name: 'a.png' }], options: {} }, { kie: kie.client }))
      .rejects.toThrow(new CreativeInputError('Model này không nhận ảnh tham chiếu'))
  })

  it('rejects an empty prompt, too many images and a bad mime', async () => {
    const kie = fakeKie({ schema: editSchema, polls: [] })
    await expect(createJob({ provider: 'kie', model: 'm', prompt: '  ', images: [], options: {} }, { kie: kie.client })).rejects.toThrow(CreativeInputError)
    const five = Array.from({ length: 5 }, (_, i) => ({ dataUrl: PNG, name: `${i}.png` }))
    await expect(createJob({ provider: 'kie', model: 'm', prompt: 'p', images: five, options: {} }, { kie: kie.client })).rejects.toThrow(/tối đa 4/)
    await expect(createJob({ provider: 'kie', model: 'm', prompt: 'p', images: [{ dataUrl: 'data:image/gif;base64,AAAA', name: 'a.gif' }], options: {} }, { kie: kie.client })).rejects.toThrow(/PNG, JPG, WEBP/)
  })

  it('rejects a model slug that is not owner/name or a bare name', async () => {
    const kie = fakeKie({ schema: textSchema, polls: [] })
    for (const bad of ['../../v1/account', 'a/b/c', 'owner/ name', '/x', 'x/']) {
      await expect(createJob({ provider: 'kie', model: bad, prompt: 'p', images: [], options: {} }, { kie: kie.client })).rejects.toThrow(/Model không hợp lệ/)
    }
  })

  it('fails when the provider has no key', async () => {
    await expect(createJob({ provider: 'replicate', model: 'qwen/qwen-image', prompt: 'p', images: [], options: {} }, {})).rejects.toThrow('Chưa có API key replicate')
  })
})

describe('refreshJob', () => {
  it('keeps running, then downloads results and records cost on done', async () => {
    const kie = fakeKie({ schema: textSchema, polls: [{ state: 'running' }, { state: 'done', urls: ['https://tempfile.redpandaai.co/x/1.png', 'https://tempfile.redpandaai.co/x/2.png'], credits: 6.5, costTime: 41 }] })
    const providers: Providers = { kie: kie.client }
    const job = await createJob({ provider: 'kie', model: 'qwen/text-to-image', prompt: 'p', images: [], options: {} }, providers)
    const still = await refreshJob(job.id, providers, downloadFetch)
    expect(still.status).toBe('running')
    const done = await refreshJob(job.id, providers, downloadFetch)
    expect(done.status).toBe('done')
    expect(JSON.parse(done.resultFiles)).toEqual(['out-0.png', 'out-1.png'])
    expect(done.cost).toBe('6.5 credits')
    expect(done.completedAt).toBeInstanceOf(Date)
    expect(done.durationMs).toBeGreaterThanOrEqual(0)
    const file = resolveFile(done.id, 'out-1.png')
    expect(file).not.toBeNull()
    expect((await fs.readFile(file!)).toString()).toBe('png-bytes-https://tempfile.redpandaai.co/x/2.png')
    const view = jobView(done)
    expect(view.resultFiles).toEqual(['out-0.png', 'out-1.png'])
    expect(view.input).toEqual({ prompt: 'p' })
  })

  it('keeps a job running when the poll itself throws, and records the last poll error', async () => {
    const providers: Providers = { kie: { ...fakeKie({ schema: textSchema, polls: [] }).client, poll: async () => { throw new Error('kie recordInfo 429: Too many requests') } } }
    const job = await createJob({ provider: 'kie', model: 'qwen/text-to-image', prompt: 'p', images: [], options: {} }, providers)
    const after = await refreshJob(job.id, providers, downloadFetch)
    expect(after.status).toBe('running')
    expect(after.error).toMatch(/429/)
  })

  it('keeps the result urls when the download fails and finishes on the next refresh', async () => {
    const kie = fakeKie({ schema: textSchema, polls: [{ state: 'done', urls: ['https://tempfile.redpandaai.co/z/1.png'], credits: 1, costTime: 5 }] })
    const providers: Providers = { kie: kie.client }
    const job = await createJob({ provider: 'kie', model: 'qwen/text-to-image', prompt: 'p', images: [], options: {} }, providers)
    const pending = await refreshJob(job.id, providers, brokenFetch)
    expect(pending.status).toBe('running')
    expect(JSON.parse(pending.resultUrls)).toEqual(['https://tempfile.redpandaai.co/z/1.png'])
    expect(pending.error).toMatch(/ECONNRESET/)
    const done = await refreshJob(job.id, { kie: { ...kie.client, poll: async () => { throw new Error('must not poll again') } } }, downloadFetch)
    expect(done.status).toBe('done')
    expect(JSON.parse(done.resultFiles)).toEqual(['out-0.png'])
    expect(done.cost).toBe('1 credits')
    expect(done.error).toBeNull()
  })

  it('gives up on a job that has been running for more than 30 minutes', async () => {
    const kie = fakeKie({ schema: textSchema, polls: [{ state: 'running' }] })
    const providers: Providers = { kie: kie.client }
    const job = await createJob({ provider: 'kie', model: 'qwen/text-to-image', prompt: 'p', images: [], options: {} }, providers)
    await prisma.creativeJob.update({ where: { id: job.id }, data: { createdAt: new Date(Date.now() - 31 * 60 * 1000) } })
    const stale = await refreshJob(job.id, providers, downloadFetch)
    expect(stale.status).toBe('failed')
    expect(stale.error).toMatch(/30 phút/)
  })

  it('marks the job failed with the provider error', async () => {
    const kie = fakeKie({ schema: textSchema, polls: [{ state: 'failed', error: 'content blocked' }] })
    const providers: Providers = { kie: kie.client }
    const job = await createJob({ provider: 'kie', model: 'qwen/text-to-image', prompt: 'p', images: [], options: {} }, providers)
    const failed = await refreshJob(job.id, providers, downloadFetch)
    expect(failed.status).toBe('failed')
    expect(failed.error).toBe('content blocked')
  })

  it('returns a done job untouched even when its files were removed from disk', async () => {
    const kie = fakeKie({ schema: textSchema, polls: [{ state: 'done', urls: ['https://tempfile.redpandaai.co/y/1.png'], credits: null, costTime: null }] })
    const providers: Providers = { kie: kie.client }
    const job = await createJob({ provider: 'kie', model: 'qwen/text-to-image', prompt: 'p', images: [], options: {} }, providers)
    const done = await refreshJob(job.id, providers, downloadFetch)
    await fs.rm(path.join(creativeRoot(), done.id), { recursive: true, force: true })
    const again = await refreshJob(job.id, providers, downloadFetch)
    expect(again.status).toBe('done')
    expect(resolveFile(again.id, 'out-0.png')).not.toBeNull()
  })
})

describe('listJobs and deleteJob', () => {
  it('filters by provider, model and status and deletes row plus folder', async () => {
    const all = await listJobs({})
    expect(all.length).toBeGreaterThanOrEqual(4)
    expect(all[0].createdAt.getTime()).toBeGreaterThanOrEqual(all[all.length - 1].createdAt.getTime())
    const done = await listJobs({ status: 'done', provider: 'kie', model: 'qwen/text-to-image' })
    expect(done.every(j => j.status === 'done' && j.model === 'qwen/text-to-image')).toBe(true)
    expect(done.length).toBe(3)
    const target = done[0]
    await deleteJob(target.id)
    expect(await prisma.creativeJob.findUnique({ where: { id: target.id } })).toBeNull()
    await expect(fs.stat(path.join(creativeRoot(), target.id))).rejects.toBeTruthy()
  })
})

describe('resolveFile', () => {
  it('refuses traversal and unknown names', () => {
    expect(resolveFile('../x', 'out-0.png')).toBeNull()
    expect(resolveFile('abc123', '../secret.png')).toBeNull()
    expect(resolveFile('abc123', 'out-0.exe')).toBeNull()
    expect(resolveFile('abc123', 'out-0.png')).toMatch(/abc123[\\/]out-0\.png$/)
  })
})
