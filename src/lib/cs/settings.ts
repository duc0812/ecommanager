import { prisma } from '@/lib/db'
import { getSettings, saveSetting } from '@/lib/token-store'
import { maskApiKey } from '@/lib/tracking/parcelpanel-config'
import { normalizeModelId } from '@/lib/llm/anthropic'

export type LlmProvider = 'anthropic' | 'kie'

export type CsSettings = {
  freshdeskDomain: string
  llmProvider: LlmProvider
  model: string
  pollEnabled: boolean
  killSwitch: boolean
  autoReplyEnabled: boolean
  autoReplyCategories: string[]
  autoReplyDailyCap: number
  notifyLevels: string[]
  productionDays: number
  shippingDays: number
  supportAgentId: number
  ignoredAgentIds: number[]
  syncUpdatedSince: string | null
  reviewEnabled: boolean
  weeklyReport: boolean
  reviewModel: string | null
  llmDailyCallCap: number
  afterHoursAutoReply: boolean
  afterHoursCategories: string[]
  businessHoursStart: number
  businessHoursEnd: number
  weekendIsAfterHours: boolean
}

export const AFTER_HOURS_DEFAULT_CATEGORIES = ['ORDER_STATUS', 'ADDRESS_CHANGE', 'CANCEL_ORDER', 'DAMAGED_OR_DEFECTIVE', 'WRONG_ITEM', 'MISSING_ITEM', 'DELIVERED_NOT_RECEIVED', 'REFUND_REQUEST', 'PRODUCT_QUESTION', 'PERSONALIZATION_ISSUE']

export const DEFAULT_CS_SETTINGS: CsSettings = {
  freshdeskDomain: 'litzzy',
  llmProvider: 'kie',
  model: 'claude-opus-5-5',
  pollEnabled: true,
  killSwitch: false,
  autoReplyEnabled: false,
  autoReplyCategories: ['ORDER_STATUS'],
  autoReplyDailyCap: 30,
  notifyLevels: ['URGENT', 'HIGH'],
  productionDays: 5,
  shippingDays: 15,
  supportAgentId: 158024049112,
  ignoredAgentIds: [158024416092, 158024416093],
  syncUpdatedSince: null,
  reviewEnabled: true,
  weeklyReport: true,
  reviewModel: null,
  llmDailyCallCap: 500,
  afterHoursAutoReply: false,
  afterHoursCategories: AFTER_HOURS_DEFAULT_CATEGORIES,
  businessHoursStart: 8,
  businessHoursEnd: 17,
  weekendIsAfterHours: true,
}

export type CsSecrets = { freshdeskApiKey: string | null; anthropicApiKey: string | null; kieApiKey: string | null }

export type CsSettingsView = CsSettings & {
  hasFreshdeskApiKey: boolean
  freshdeskApiKeyMasked: string | null
  hasAnthropicApiKey: boolean
  anthropicApiKeyMasked: string | null
  hasKieApiKey: boolean
  kieApiKeyMasked: string | null
}

const KEY = 'cs.settings'
const SECRET_KEYS = { freshdeskApiKey: 'cs.freshdeskApiKey', anthropicApiKey: 'cs.anthropicApiKey', kieApiKey: 'cs.kieApiKey' } as const

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const hour = (v: unknown, d: number) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 23 ? v : d)
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d)
const strList = (v: unknown, d: string[]) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : d)
const numList = (v: unknown, d: number[]) => (Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : d)

function normalize(parsed: any): CsSettings {
  const d = DEFAULT_CS_SETTINGS
  return {
    freshdeskDomain: typeof parsed.freshdeskDomain === 'string' && parsed.freshdeskDomain.trim() ? parsed.freshdeskDomain.trim() : d.freshdeskDomain,
    llmProvider: parsed.llmProvider === 'anthropic' || parsed.llmProvider === 'kie' ? parsed.llmProvider : d.llmProvider,
    model: typeof parsed.model === 'string' && parsed.model.trim() ? normalizeModelId(parsed.model) : d.model,
    pollEnabled: bool(parsed.pollEnabled, d.pollEnabled),
    killSwitch: bool(parsed.killSwitch, d.killSwitch),
    autoReplyEnabled: bool(parsed.autoReplyEnabled, d.autoReplyEnabled),
    autoReplyCategories: strList(parsed.autoReplyCategories, d.autoReplyCategories),
    autoReplyDailyCap: num(parsed.autoReplyDailyCap, d.autoReplyDailyCap),
    notifyLevels: strList(parsed.notifyLevels, d.notifyLevels),
    productionDays: num(parsed.productionDays, d.productionDays),
    shippingDays: num(parsed.shippingDays, d.shippingDays),
    supportAgentId: num(parsed.supportAgentId, d.supportAgentId),
    ignoredAgentIds: numList(parsed.ignoredAgentIds, d.ignoredAgentIds),
    syncUpdatedSince: typeof parsed.syncUpdatedSince === 'string' ? parsed.syncUpdatedSince : null,
    reviewEnabled: bool(parsed.reviewEnabled, d.reviewEnabled),
    weeklyReport: bool(parsed.weeklyReport, d.weeklyReport),
    reviewModel: typeof parsed.reviewModel === 'string' && parsed.reviewModel.trim() ? normalizeModelId(parsed.reviewModel) : null,
    llmDailyCallCap: num(parsed.llmDailyCallCap, d.llmDailyCallCap),
    afterHoursAutoReply: bool(parsed.afterHoursAutoReply, d.afterHoursAutoReply),
    afterHoursCategories: strList(parsed.afterHoursCategories, d.afterHoursCategories),
    businessHoursStart: hour(parsed.businessHoursStart, d.businessHoursStart),
    businessHoursEnd: hour(parsed.businessHoursEnd, d.businessHoursEnd),
    weekendIsAfterHours: bool(parsed.weekendIsAfterHours, d.weekendIsAfterHours),
  }
}

export async function getCsSettings(): Promise<CsSettings> {
  const row = await prisma.appSetting.findUnique({ where: { key: KEY } })
  if (!row) return DEFAULT_CS_SETTINGS
  try { return normalize(JSON.parse(row.value)) } catch { return DEFAULT_CS_SETTINGS }
}

export async function saveCsSettings(patch: Partial<CsSettings>): Promise<CsSettings> {
  const next = normalize({ ...(await getCsSettings()), ...patch })
  const value = JSON.stringify(next)
  await prisma.appSetting.upsert({ where: { key: KEY }, create: { key: KEY, value }, update: { value } })
  return next
}

export async function getCsSecrets(): Promise<CsSecrets> {
  const raw = await getSettings(Object.values(SECRET_KEYS))
  const pick = (key: string, env: string | undefined) => raw[key]?.trim() || env?.trim() || null
  return {
    freshdeskApiKey: pick(SECRET_KEYS.freshdeskApiKey, process.env.FRESHDESK_API_KEY),
    anthropicApiKey: pick(SECRET_KEYS.anthropicApiKey, process.env.ANTHROPIC_API_KEY),
    kieApiKey: pick(SECRET_KEYS.kieApiKey, process.env.KIE_API_KEY),
  }
}

export async function saveCsSecrets(p: { freshdeskApiKey?: string; anthropicApiKey?: string; kieApiKey?: string }) {
  if (p.freshdeskApiKey?.trim()) await saveSetting(SECRET_KEYS.freshdeskApiKey, p.freshdeskApiKey.trim())
  if (p.anthropicApiKey?.trim()) await saveSetting(SECRET_KEYS.anthropicApiKey, p.anthropicApiKey.trim())
  if (p.kieApiKey?.trim()) await saveSetting(SECRET_KEYS.kieApiKey, p.kieApiKey.trim())
}

export function toCsSettingsView(s: CsSettings, secrets: CsSecrets): CsSettingsView {
  return {
    ...s,
    hasFreshdeskApiKey: !!secrets.freshdeskApiKey,
    freshdeskApiKeyMasked: maskApiKey(secrets.freshdeskApiKey),
    hasAnthropicApiKey: !!secrets.anthropicApiKey,
    anthropicApiKeyMasked: maskApiKey(secrets.anthropicApiKey),
    hasKieApiKey: !!secrets.kieApiKey,
    kieApiKeyMasked: maskApiKey(secrets.kieApiKey),
  }
}
