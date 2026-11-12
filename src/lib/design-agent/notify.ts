import type { AgentJobKind } from '@/lib/design-agent/jobs'
import { larkApi, type LarkApi } from '@/lib/lark/api'
import { getLarkConfig, isLarkConfigured } from '@/lib/lark/settings'

export type OwnerNotice = { jobId: string; taskKey: string | null; kind: AgentJobKind; reason: 'NEEDS_OWNER' | 'FAILED'; summary: string }

export function ownerNoticeText(notice: OwnerNotice): string {
  const what = notice.taskKey ?? `job ${notice.jobId}`
  const head = notice.reason === 'FAILED' ? 'Agent không chạy được' : 'Agent cần chủ shop'
  return `${head} — ${what}: ${notice.summary.slice(0, 300)}`
}

export async function notifyNeedsOwner(notice: OwnerNotice, deps: { lark?: LarkApi } = {}): Promise<void> {
  try {
    const config = await getLarkConfig()
    if (!config.enabled || !isLarkConfigured(config)) return
    const lark = deps.lark ?? larkApi(config)
    await lark.sendToChat(config.chatId, ownerNoticeText(notice), config.ownerOpenId || undefined)
  } catch (e) {
    console.error('[lark] chưa báo được chủ shop', (e as Error)?.message ?? String(e))
  }
}
