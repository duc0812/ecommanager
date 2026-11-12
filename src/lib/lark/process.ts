import type { AcceptedLarkMessage } from '@/lib/lark/events'
import type { LarkApi } from '@/lib/lark/api'

export type LarkDeps = { lark: LarkApi; llm: unknown; now?: Date }

export async function processLarkMessage(
  msg: AcceptedLarkMessage, deps: Partial<LarkDeps> = {},
): Promise<{ outcome: 'JOB' | 'REPLIED' | 'IGNORED' | 'ERROR'; jobIds: string[]; reply: string | null }> {
  void msg; void deps
  return { outcome: 'IGNORED', jobIds: [], reply: null }
}
