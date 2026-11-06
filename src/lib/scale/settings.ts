import { prisma } from '@/lib/db'
import { getCreativeSecrets } from '@/lib/creative/settings'
import { isValidModelSlug } from '@/lib/creative/jobs'
import { kieClient } from '@/lib/creative/kie'
import { getCsSecrets, getCsSettings } from '@/lib/cs/settings'
import { maskApiKey } from '@/lib/tracking/parcelpanel-config'
import { kieVision, type Vision } from '@/lib/scale/vision'

export class ScaleInputError extends Error {
  constructor(message: string) { super(message); this.name = 'ScaleInputError' }
}

export type ScaleSettings = { imageModel: string; fallbackModel: string; allowFallback: boolean; visionModel: string | null; resolution: string }

export const DEFAULT_SCALE_SETTINGS: ScaleSettings = {
  imageModel: 'gpt-image-2-5-flare-image-to-image',
  fallbackModel: 'seedream/4.5-edit',
  allowFallback: false,
  visionModel: null,
  resolution: '2K',
}

export type ImageClient = Pick<ReturnType<typeof kieClient>, 'schema' | 'uploadBase64' | 'createTask' | 'poll'>
export type ScaleDeps = { image: ImageClient | null; vision: Vision | null; settings: ScaleSettings; visionModel: string; fetchImpl: typeof fetch }

const KEY = 'scale.settings'

function normalize(raw: any): ScaleSettings {
  const d = DEFAULT_SCALE_SETTINGS
  const slug = (v: unknown, fallback: string) => (typeof v === 'string' && v.trim() && isValidModelSlug(v.trim()) ? v.trim() : fallback)
  return {
    imageModel: slug(raw?.imageModel, d.imageModel),
    fallbackModel: slug(raw?.fallbackModel, d.fallbackModel),
    allowFallback: typeof raw?.allowFallback === 'boolean' ? raw.allowFallback : d.allowFallback,
    visionModel: typeof raw?.visionModel === 'string' && raw.visionModel.trim() && isValidModelSlug(raw.visionModel.trim()) ? raw.visionModel.trim() : null,
    resolution: typeof raw?.resolution === 'string' && /^[A-Za-z0-9]{1,8}$/.test(raw.resolution.trim()) ? raw.resolution.trim() : d.resolution,
  }
}

export async function getScaleSettings(): Promise<ScaleSettings> {
  const row = await prisma.appSetting.findUnique({ where: { key: KEY } })
  if (!row) return DEFAULT_SCALE_SETTINGS
  try { return normalize(JSON.parse(row.value)) } catch { return DEFAULT_SCALE_SETTINGS }
}

export async function saveScaleSettings(patch: Partial<ScaleSettings>): Promise<ScaleSettings> {
  for (const field of ['imageModel', 'fallbackModel', 'visionModel'] as const) {
    const v = patch[field]
    if (typeof v === 'string' && v.trim() && !isValidModelSlug(v.trim())) throw new ScaleInputError(`Model không hợp lệ: ${v}`)
  }
  const next = normalize({ ...(await getScaleSettings()), ...patch })
  const value = JSON.stringify(next)
  await prisma.appSetting.upsert({ where: { key: KEY }, create: { key: KEY, value }, update: { value } })
  return next
}

async function effectiveVisionModel(settings: ScaleSettings): Promise<string> {
  return settings.visionModel ?? (await getCsSettings()).model
}

export async function scaleSettingsView() {
  const [settings, creative, cs] = await Promise.all([getScaleSettings(), getCreativeSecrets(), getCsSecrets()])
  return {
    ...settings,
    effectiveVisionModel: await effectiveVisionModel(settings),
    imageKeyMasked: maskApiKey(creative.kieApiKey),
    imageKeySource: creative.kieSource,
    visionKeyMasked: maskApiKey(cs.kieApiKey),
  }
}

export async function loadScaleDeps(): Promise<ScaleDeps> {
  const [settings, creative, cs] = await Promise.all([getScaleSettings(), getCreativeSecrets(), getCsSecrets()])
  return {
    image: creative.kieApiKey ? kieClient(creative.kieApiKey) : null,
    vision: cs.kieApiKey ? kieVision(cs.kieApiKey) : null,
    settings,
    visionModel: await effectiveVisionModel(settings),
    fetchImpl: fetch,
  }
}

export function explainKieError(err: unknown, key: 'Creative' | 'CS', slug: string): string {
  const message = String((err as any)?.message ?? err)
  if (/not authorized/i.test(message) || /\b401\b/.test(message)) return `Key Kie (${key}) chưa được cấp quyền model ${slug}`
  return message
}
