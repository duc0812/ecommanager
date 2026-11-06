import { prisma } from '@/lib/db'
import { CloneInputError } from '@/lib/clone/jobs'

export const CLONE_SETTINGS_KEY = 'clone.settings'

export type CloneSettings = { paused: boolean; targets: string[] }

const TARGET_RE = /^(customily|customall|teeinblue|customix):[A-Z]+$/

const isTarget = (v: unknown): v is string => typeof v === 'string' && TARGET_RE.test(v)

function readStored(raw: string | undefined): CloneSettings {
  let parsed: unknown
  try {
    parsed = raw === undefined ? null : JSON.parse(raw)
  } catch {
    parsed = null
  }
  const obj = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  return {
    paused: obj.paused === true,
    targets: Array.isArray(obj.targets) ? Array.from(new Set(obj.targets.filter(isTarget))) : [],
  }
}

export async function getCloneSettings(): Promise<CloneSettings> {
  const row = await prisma.appSetting.findUnique({ where: { key: CLONE_SETTINGS_KEY }, select: { value: true } })
  return readStored(row?.value)
}

// A field left out keeps its current value; a field that is present but malformed rejects the whole save.
export async function saveCloneSettings(input: unknown): Promise<CloneSettings> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new CloneInputError(400, 'Cài đặt không hợp lệ.')
  const body = input as Record<string, unknown>
  if (body.paused !== undefined && typeof body.paused !== 'boolean') throw new CloneInputError(400, 'Giá trị tạm dừng không hợp lệ.')
  if (body.targets !== undefined && !(Array.isArray(body.targets) && body.targets.every(isTarget))) {
    throw new CloneInputError(400, 'Danh sách nền tảng và store không hợp lệ.')
  }
  const current = await getCloneSettings()
  const next: CloneSettings = {
    paused: body.paused ?? current.paused,
    targets: body.targets === undefined ? current.targets : Array.from(new Set(body.targets as string[])),
  }
  const value = JSON.stringify(next)
  await prisma.appSetting.upsert({ where: { key: CLONE_SETTINGS_KEY }, create: { key: CLONE_SETTINGS_KEY, value }, update: { value } })
  return next
}
