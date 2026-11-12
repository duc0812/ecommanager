import type { AgentJobKind } from '@/lib/design-agent/jobs'

export type OwnerNotice = { jobId: string; taskKey: string | null; kind: AgentJobKind; reason: 'NEEDS_OWNER' | 'FAILED'; summary: string }

export async function notifyNeedsOwner(notice: OwnerNotice): Promise<void> {
  console.warn('[design agent] cần chủ shop', notice.jobId, notice.taskKey)
}
