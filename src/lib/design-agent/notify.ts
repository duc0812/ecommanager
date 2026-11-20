import type { AgentJobKind } from '@/lib/design-agent/jobs'
import { larkApi, type LarkApi } from '@/lib/lark/api'
import { cutLine } from '@/lib/lark/replies'
import { getLarkConfig, isLarkConfigured } from '@/lib/lark/settings'

export const OWNER_NAME = 'anh Đức'
const MAX_HOLDER = 80

// The group only ever gets these fixed lines (owner 11/19/2026): a job's summary, error or question stays on the tool.
export type OwnerNotice = { jobId: string; taskKey: string | null; kind: AgentJobKind; reason: 'NEEDS_OWNER' | 'FAILED' }

export const noticeKey = (job: { id: string; taskKey: string | null }) => job.taskKey ?? `job ${job.id}`

export function ownerNoticeText(notice: OwnerNotice): string {
  return `${noticeKey({ id: notice.jobId, taskKey: notice.taskKey })}: Agent chưa làm được, đã báo ${OWNER_NAME} kiểm tra lại.`
}

export function doneNoticeText(key: string, kind: AgentJobKind): string {
  return kind === 'MOCKUP' ? `${key}: Agent đã làm xong mockup, xem trên tool.` : `${key}: Agent đã làm xong, đang chờ duyệt trên tool.`
}

export function busyNoticeText(key: string, holder: string): string {
  return `${key}: Agent dừng việc này vì ${cutLine(holder, MAX_HOLDER)} đang làm.`
}

/**
 * A line its supplier already has was approved with a new design (owner 11/20/2026). By a link (sheet, CSV): someone has to
 * tell the supplier; by an API push: the line is back at hand-off to be sent again.
 */
export function supplierFixNoticeText(key: string, supplierName: string, kind: 'LINK' | 'API'): string {
  const head = `Đơn ${key} đã gửi xưởng ${supplierName} được update design mới`
  return kind === 'LINK' ? `${head}, check design và báo xưởng nhé.` : `${head}, check design rồi gửi lại xưởng trên tool nhé.`
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

/** A line for the whole group, nobody mentioned. Never throws. */
export async function notifyGroup(text: string, deps: { lark?: LarkApi } = {}): Promise<void> {
  try {
    const config = await getLarkConfig()
    if (!config.enabled || !isLarkConfigured(config)) return
    const lark = deps.lark ?? larkApi(config)
    await lark.sendToChat(config.chatId, text)
  } catch (e) {
    console.error('[lark] chưa báo được vào group', (e as Error)?.message ?? String(e))
  }
}
