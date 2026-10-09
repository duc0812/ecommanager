import crypto from 'crypto'
import type { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { mapTemplate } from '@/lib/design-tasks'

export const WORKER_TOKEN_KEY = 'design.worker.tokenHash'
export const JOB_STALE_MS = 15 * 60 * 1000
export const MAX_JOB_ATTEMPTS = 3

function sha256Hex(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex')
}

export async function generateWorkerToken(): Promise<string> {
  const token = `dsw_${crypto.randomBytes(32).toString('base64url')}`
  const value = sha256Hex(token)
  await prisma.appSetting.upsert({ where: { key: WORKER_TOKEN_KEY }, create: { key: WORKER_TOKEN_KEY, value }, update: { value } })
  return token
}

export async function revokeWorkerToken(): Promise<void> {
  await prisma.appSetting.deleteMany({ where: { key: WORKER_TOKEN_KEY } })
}

export async function workerTokenInfo(): Promise<{ configured: boolean; updatedAt: string | null }> {
  const row = await prisma.appSetting.findUnique({ where: { key: WORKER_TOKEN_KEY } })
  return { configured: !!row?.value, updatedAt: row?.updatedAt.toISOString() ?? null }
}

export async function verifyWorkerToken(header: string | null): Promise<boolean> {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '')
  if (!m) return false
  const row = await prisma.appSetting.findUnique({ where: { key: WORKER_TOKEN_KEY } })
  if (!row?.value || !/^[0-9a-f]{64}$/.test(row.value)) return false
  const expected = Buffer.from(row.value, 'hex')
  const actual = Buffer.from(sha256Hex(m[1]), 'hex')
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual)
}

export function verifyWorkerRequest(req: NextRequest): Promise<boolean> {
  return verifyWorkerToken(req.headers.get('authorization'))
}

export type ClaimResponse = {
  job: { id: string; kind: string; attempts: number; createdAt: string }
  entry: { id: string; storeId: string; shopifyProductId: string; title: string; status: string; fields: unknown[] }
  template: {
    id: string; name: string; widthPx: number; heightPx: number; dpi: number; bleedIn: number; safeIn: number; mirror: boolean
    areas: { name: string; x: number; y: number; w: number; h: number }[]
  }
  psdFileId: string
  psd: { id: string; fileName: string; size: number; sha256: string }
}

async function failExhausted(jobId: string, entryId: string, error: string) {
  const r = await prisma.artworkJob.updateMany({ where: { id: jobId, status: 'RUNNING' }, data: { status: 'FAILED', error, finishedAt: new Date() } })
  if (r.count > 0) await prisma.artworkEntry.updateMany({ where: { id: entryId, status: { in: ['QUEUED', 'PARSING'] } }, data: { status: 'ERROR', error } })
}

export async function claimJob(now = new Date()): Promise<ClaimResponse | null> {
  const staleBefore = new Date(now.getTime() - JOB_STALE_MS)
  const reclaimable = { OR: [{ status: 'QUEUED' }, { status: 'RUNNING', lockedAt: { lt: staleBefore } }] }
  for (let round = 0; round < 20; round++) {
    const candidates = await prisma.artworkJob.findMany({
      where: { kind: 'PARSE_PSD', ...reclaimable },
      orderBy: { createdAt: 'asc' },
      take: 5,
      select: { id: true, entryId: true, status: true, attempts: true },
    })
    if (candidates.length === 0) return null
    for (const c of candidates) {
      if (c.status === 'RUNNING' && c.attempts >= MAX_JOB_ATTEMPTS) {
        await failExhausted(c.id, c.entryId, `Worker không trả kết quả sau ${c.attempts} lần`)
        continue
      }
      const won = await prisma.artworkJob.updateMany({
        where: { id: c.id, ...reclaimable },
        data: { status: 'RUNNING', lockedAt: now, attempts: { increment: 1 } },
      })
      if (won.count === 0) continue
      const job = await prisma.artworkJob.findUniqueOrThrow({
        where: { id: c.id },
        include: { entry: { include: { printTemplate: true, psdFile: true } } },
      })
      const { entry } = job
      if (!entry.psdFile) {
        await prisma.artworkJob.update({ where: { id: job.id }, data: { status: 'FAILED', error: 'Entry không có PSD', finishedAt: new Date() } })
        await prisma.artworkEntry.update({ where: { id: entry.id }, data: { status: 'ERROR', error: 'Entry không có PSD' } })
        continue
      }
      await prisma.artworkEntry.update({ where: { id: entry.id }, data: { status: 'PARSING' } })
      const t = mapTemplate(entry.printTemplate)
      let fields: unknown[] = []
      try { const v = JSON.parse(entry.fields); if (Array.isArray(v)) fields = v } catch {}
      return {
        job: { id: job.id, kind: job.kind, attempts: job.attempts, createdAt: job.createdAt.toISOString() },
        entry: { id: entry.id, storeId: entry.storeId, shopifyProductId: entry.shopifyProductId, title: entry.title, status: 'PARSING', fields },
        template: {
          id: t.id, name: t.name, widthPx: t.widthPx, heightPx: t.heightPx, dpi: t.dpi, bleedIn: t.bleedIn, safeIn: t.safeIn, mirror: t.mirror, areas: t.areas,
        },
        psdFileId: entry.psdFile.id,
        psd: { id: entry.psdFile.id, fileName: entry.psdFile.fileName, size: entry.psdFile.size, sha256: entry.psdFile.sha256 },
      }
    }
  }
  return null
}

export async function recordJobFailure(jobId: string, error: string, permanent = false): Promise<{ status: 'QUEUED' | 'FAILED'; attempts: number } | null> {
  const job = await prisma.artworkJob.findUnique({ where: { id: jobId } })
  if (!job || job.status !== 'RUNNING') return null
  const message = error.trim().slice(0, 2000) || 'Lỗi không rõ'
  const exhausted = permanent || job.attempts >= MAX_JOB_ATTEMPTS
  const r = await prisma.artworkJob.updateMany({
    where: { id: jobId, status: 'RUNNING' },
    data: exhausted
      ? { status: 'FAILED', error: message, finishedAt: new Date(), lockedAt: null }
      : { status: 'QUEUED', error: message, lockedAt: null },
  })
  if (r.count === 0) return null
  await prisma.artworkEntry.update({
    where: { id: job.entryId },
    data: exhausted ? { status: 'ERROR', error: message } : { status: 'QUEUED', error: message },
  })
  return { status: exhausted ? 'FAILED' : 'QUEUED', attempts: job.attempts }
}

export async function workerFonts() {
  const fonts = await prisma.designFont.findMany({ orderBy: { postscriptName: 'asc' }, include: { file: { select: { sha256: true, fileName: true, size: true } } } })
  return fonts.map(f => ({
    postscriptName: f.postscriptName, fileId: f.fileId, sha256: f.file.sha256, family: f.family, style: f.style, fileName: f.file.fileName, size: f.file.size,
  }))
}
