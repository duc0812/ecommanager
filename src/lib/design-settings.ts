import { prisma } from '@/lib/db'

export const TRELLO_MODES = ['BOTH', 'READ_ONLY', 'OFF'] as const
/** BOTH = Trello cards are created and read; READ_ONLY = no new card, existing cards are still read; OFF = neither. */
export type TrelloMode = typeof TRELLO_MODES[number]

export function isTrelloMode(v: unknown): v is TrelloMode {
  return typeof v === 'string' && (TRELLO_MODES as readonly string[]).includes(v)
}

export const TRELLO_OFF_MESSAGE = 'Trello đang tắt (Design Studio → Settings → Trello) — không đọc thẻ Trello'

export type AgentSettings = { autoFixOnReject: boolean; maxConcurrent: number; leaseMinutes: number }

export const DEFAULT_AGENT_SETTINGS: AgentSettings = { autoFixOnReject: false, maxConcurrent: 5, leaseMinutes: 20 }

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
  return Math.min(max, Math.max(min, Math.round(v)))
}

export function normalizeAgentSettings(raw: unknown): AgentSettings {
  const r = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  return {
    autoFixOnReject: typeof r.autoFixOnReject === 'boolean' ? r.autoFixOnReject : DEFAULT_AGENT_SETTINGS.autoFixOnReject,
    maxConcurrent: clampInt(r.maxConcurrent, 1, 10, DEFAULT_AGENT_SETTINGS.maxConcurrent),
    leaseMinutes: clampInt(r.leaseMinutes, 5, 120, DEFAULT_AGENT_SETTINGS.leaseMinutes),
  }
}

export type DesignSettings = {
  slaCustomHours: number
  slaNonCustomHours: number
  kpiByType: Record<string, number>
  rejectReasons: string[]
  designerCanApprove: boolean
  trelloMode: TrelloMode
  agent: AgentSettings
}

export const DEFAULT_DESIGN_SETTINGS: DesignSettings = {
  slaCustomHours: 24,
  slaNonCustomHours: 48,
  kpiByType: { jersey: 0.3, shirt: 0.3, hoodie: 0.4, socks: 0.4, ornament: 0.2, tumbler: 0.15, mug: 0.15, default: 0.3 },
  rejectReasons: ['Sai chính tả / nội dung', 'Lệch tâm / ra ngoài vùng an toàn', 'Thiếu nét', 'Sai màu / biến thể', 'Thiếu bleed', 'Font sai', 'Nền không đồng màu giữa các mảnh', 'Hoạ tiết chính nằm ngoài safe zone', 'Sai template đang mapping', 'Sai chi tiết'],
  designerCanApprove: true,
  trelloMode: 'BOTH',
  agent: DEFAULT_AGENT_SETTINGS,
}

const KEY = 'design.settings'

export async function getDesignSettings(): Promise<DesignSettings> {
  const row = await prisma.appSetting.findUnique({ where: { key: KEY } })
  if (!row) return DEFAULT_DESIGN_SETTINGS
  try {
    const parsed = JSON.parse(row.value)
    return {
      ...DEFAULT_DESIGN_SETTINGS,
      ...parsed,
      kpiByType: { ...DEFAULT_DESIGN_SETTINGS.kpiByType, ...(parsed.kpiByType ?? {}) },
      rejectReasons: Array.isArray(parsed.rejectReasons) && parsed.rejectReasons.length ? parsed.rejectReasons : DEFAULT_DESIGN_SETTINGS.rejectReasons,
      designerCanApprove: typeof parsed.designerCanApprove === 'boolean' ? parsed.designerCanApprove : DEFAULT_DESIGN_SETTINGS.designerCanApprove,
      trelloMode: isTrelloMode(parsed.trelloMode) ? parsed.trelloMode : DEFAULT_DESIGN_SETTINGS.trelloMode,
      agent: normalizeAgentSettings(parsed.agent),
    }
  } catch { return DEFAULT_DESIGN_SETTINGS }
}

export async function getTrelloMode(): Promise<TrelloMode> {
  return (await getDesignSettings()).trelloMode
}

export async function saveDesignSettings(s: DesignSettings) {
  await prisma.appSetting.upsert({ where: { key: KEY }, create: { key: KEY, value: JSON.stringify(s) }, update: { value: JSON.stringify(s) } })
}

export async function saveAgentSettings(patch: Partial<AgentSettings>): Promise<AgentSettings> {
  const current = await getDesignSettings()
  const agent = normalizeAgentSettings({ ...current.agent, ...patch })
  await saveDesignSettings({ ...current, agent })
  return agent
}

export function kpiForProductType(s: DesignSettings, productType: string | null): number {
  const t = (productType ?? '').toLowerCase()
  for (const [k, v] of Object.entries(s.kpiByType)) if (k !== 'default' && t.includes(k)) return v
  return s.kpiByType.default ?? 0.3
}
