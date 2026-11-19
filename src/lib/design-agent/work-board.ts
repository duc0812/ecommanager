import { prisma } from '@/lib/db'
import type { WorkBoardEntry } from '@/generated/prisma/client'
import { AgentJobError } from '@/lib/design-agent/jobs'
import { getSettings } from '@/lib/token-store'

export const BOARD_STALE_MS = 600_000
export const MAX_BOARD_ENTRIES = 5000
const MAX_INT32 = 2_147_483_647
const PUBLISHED_AT_KEY = 'design.board.publishedAt'
const REJECTED_OWNER_KEY = 'design.board.rejectedOwner'
const BOARD_SOURCES = ['LOCAL_QUEUE', 'STREAM'] as const

export type BoardEntryInput = {
  taskKey: string
  source: (typeof BOARD_SOURCES)[number]
  worker: string
  state: string
  detail?: string | null
  version?: number | null
  etaAt?: string | null
}

const filled = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

function rowProblem(row: unknown): string | null {
  if (typeof row !== 'object' || row === null) return 'không phải object'
  const r = row as Record<string, unknown>
  if (!filled(r.taskKey)) return 'thiếu taskKey'
  if (!BOARD_SOURCES.includes(r.source as BoardEntryInput['source'])) return 'source không hợp lệ'
  if (!filled(r.worker)) return 'thiếu worker'
  if (!filled(r.state)) return 'thiếu state'
  if (r.detail != null && typeof r.detail !== 'string') return 'detail không hợp lệ'
  if (r.version != null && !(Number.isInteger(r.version) && (r.version as number) >= 0 && (r.version as number) <= MAX_INT32)) return 'version không hợp lệ'
  if (r.etaAt != null && (typeof r.etaAt !== 'string' || Number.isNaN(Date.parse(r.etaAt)))) return 'etaAt không hợp lệ'
  return null
}

export function parseBoardEntries(value: unknown): BoardEntryInput[] {
  if (!Array.isArray(value)) throw new AgentJobError('entries phải là một mảng.', 400)
  if (value.length > MAX_BOARD_ENTRIES) throw new AgentJobError(`Tối đa ${MAX_BOARD_ENTRIES} dòng mỗi lần đăng.`, 400)
  value.forEach((row, i) => {
    const problem = rowProblem(row)
    if (problem) throw new AgentJobError(`Dòng ${i + 1}: ${problem}.`, 400)
  })
  return value as BoardEntryInput[]
}

const setting = (key: string, value: string) =>
  prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } })

export async function replaceWorkBoard(
  input: { entries: BoardEntryInput[]; rejectedOwner?: string | null },
  now: Date = new Date(),
): Promise<{ count: number }> {
  const [, created] = await prisma.$transaction([
    prisma.workBoardEntry.deleteMany({}),
    prisma.workBoardEntry.createMany({
      data: input.entries.map(e => ({
        taskKey: e.taskKey,
        source: e.source,
        worker: e.worker,
        state: e.state,
        detail: e.detail ?? null,
        version: e.version ?? null,
        etaAt: e.etaAt ? new Date(e.etaAt) : null,
        publishedAt: now,
      })),
    }),
    setting(PUBLISHED_AT_KEY, now.toISOString()),
    setting(REJECTED_OWNER_KEY, input.rejectedOwner ?? ''),
  ])
  return { count: created.count }
}

export async function readWorkBoard(
  taskKeys: string[] | null,
  now: Date = new Date(),
): Promise<{ fresh: boolean; publishedAt: Date | null; rejectedOwner: string | null; entries: WorkBoardEntry[] }> {
  const settings = await getSettings([PUBLISHED_AT_KEY, REJECTED_OWNER_KEY])
  const entries = await prisma.workBoardEntry.findMany({
    where: taskKeys ? { taskKey: { in: taskKeys } } : undefined,
    orderBy: [{ taskKey: 'asc' }, { id: 'asc' }],
  })
  const parsed = settings[PUBLISHED_AT_KEY] ? new Date(settings[PUBLISHED_AT_KEY]) : null
  const publishedAt = parsed && !Number.isNaN(parsed.getTime()) ? parsed : null
  return {
    fresh: publishedAt !== null && now.getTime() - publishedAt.getTime() <= BOARD_STALE_MS,
    publishedAt,
    rejectedOwner: settings[REJECTED_OWNER_KEY] || null,
    entries,
  }
}
