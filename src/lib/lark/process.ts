import { prisma } from '@/lib/db'
import type { AcceptedLarkMessage } from '@/lib/lark/events'
import { larkApi, type LarkApi } from '@/lib/lark/api'
import { getLarkConfig } from '@/lib/lark/settings'
import { larkLlm, parseLarkIntent, type LarkLlm } from '@/lib/lark/intent'
import { resolveTaskRefs } from '@/lib/lark/resolve'
import {
  REPLY_FAILED, REPLY_NOT_READ, REPLY_OTHER, REPLY_OUT_OF_SCOPE, REPLY_SENT, REPLY_UNCLEAR,
  replyAccepted, replyAmbiguous, replyAppended, replyAskCustomer, replyCancelled, replyOrderClosed, replyRunning, replyWhatToFix,
} from '@/lib/lark/replies'
import { AgentJobError, enqueueAgentJob, openJobForTask, type AgentJobKind } from '@/lib/design-agent/jobs'
import { agentAddNote, agentRejectReview, agentReopenTask, type AgentTaskState } from '@/lib/design-agent/delivery'

export type LarkDeps = { lark: LarkApi; llm: LarkLlm | null; now?: Date }
type Outcome = 'JOB' | 'REPLIED' | 'IGNORED' | 'ERROR'
type Processed = { outcome: Outcome; jobIds: string[]; reply: string | null }

const NO_KEY = 'Chưa có API key cho Claude'
const FIX_FROM = ['REJECTED', 'NEW', 'ASSIGNED', 'DOING']
const MAX_ERROR = 1000

const errText = (e: unknown) => String((e as Error)?.message ?? e).slice(0, MAX_ERROR)

async function enqueueFor(kind: AgentJobKind, task: AgentTaskState, instruction: string, sender: string, accepted = false): Promise<{ jobId: string | null; reply: string }> {
  const { job, created, appended } = await enqueueAgentJob({
    kind, source: 'LARK', taskKey: task.taskKey, requestText: `Yêu cầu từ Lark (${sender}): ${instruction}`, requestedBy: sender,
  })
  if (created) return { jobId: job.id, reply: replyAccepted(task.taskKey, instruction) }
  if (appended) return { jobId: job.id, reply: accepted ? replyAccepted(task.taskKey, instruction) : replyAppended(task.taskKey) }
  await agentAddNote(task.taskKey, `Lark – ${sender}: ${instruction}`)
  return { jobId: null, reply: replyRunning(task.taskKey) }
}

export async function requestForTask(
  kind: 'FIX' | 'NEW_DESIGN' | 'MOCKUP', task: AgentTaskState, instruction: string, sender: string,
): Promise<{ jobId: string | null; reply: string; error?: string }> {
  const key = task.taskKey
  if (task.status === 'CANCELLED') return { jobId: null, reply: replyCancelled(key) }
  if (!task.orderOpen) return { jobId: null, reply: replyOrderClosed(key) }
  if (task.status === 'ASK_CUSTOMER') return { jobId: null, reply: replyAskCustomer(key) }
  if (kind === 'MOCKUP') return enqueueFor('MOCKUP', task, instruction, sender)
  if (kind === 'NEW_DESIGN' && (task.status === 'NEW' || task.status === 'ASSIGNED')) return enqueueFor('MAKE', task, instruction, sender)
  if (instruction.trim().length < 3) return { jobId: null, reply: replyWhatToFix(key) }
  if (FIX_FROM.includes(task.status)) return enqueueFor('FIX', task, instruction, sender)
  if (task.status === 'DONE' && task.sent) return { jobId: null, reply: REPLY_SENT }
  const open = await openJobForTask(task.taskId)
  if (open?.status === 'RUNNING') return enqueueFor('FIX', task, instruction, sender)
  const note = `Theo yêu cầu của ${sender} trên Lark`
  if (task.status === 'REVIEW') {
    await agentRejectReview(key, { reason: `Khác: ${instruction.trim().slice(0, 200)}`, note })
    return enqueueAfterMove(task, instruction, sender, { did: 'trả lại', after: 'trả lại sửa' }, true)
  }
  if (task.status === 'DONE') {
    await agentReopenTask(key, { note }, { allowSent: false })
    return enqueueAfterMove(task, instruction, sender, { did: 'mở lại', after: 'mở lại để sửa' })
  }
  return enqueueFor('FIX', task, instruction, sender)
}

async function enqueueAfterMove(
  task: AgentTaskState, instruction: string, sender: string, move: { did: string; after: string }, accepted = false,
): Promise<{ jobId: string | null; reply: string; error?: string }> {
  try {
    return await enqueueFor('FIX', task, instruction, sender, accepted)
  } catch (e) {
    const error = `${task.taskKey}: ${errText(e)}`
    await agentAddNote(task.taskKey, `không xếp được việc sau khi ${move.after} theo yêu cầu Lark; cần xếp lại`)
      .catch(n => console.error('[lark] chưa ghi được ghi chú', errText(n)))
    return { jobId: null, reply: `${task.taskKey}: đã ${move.did} task nhưng chưa xếp được việc cho Agent — hãy xếp lại trên tool.`, error }
  }
}

function stripMentions(text: string, msg: AcceptedLarkMessage): string {
  let out = text
  for (const m of msg.mentions) if (m.key) out = out.split(m.key).join(' ')
  return out.replace(/\s+/g, ' ').trim()
}

async function record(eventId: string, data: { senderName?: string | null; outcome: Outcome; jobIds: string[]; reply: string | null; error: string | null }) {
  await prisma.larkEvent.updateMany({
    where: { eventId },
    data: {
      senderName: data.senderName ?? null, outcome: data.outcome, reply: data.reply, error: data.error,
      jobIds: data.jobIds.length ? JSON.stringify(data.jobIds) : null,
    },
  }).catch(e => console.error('[lark] chưa ghi được sự kiện', errText(e)))
}

async function decide(text: string, sender: string, llm: LarkLlm | null, now?: Date): Promise<{ outcome: Outcome; jobIds: string[]; lines: string[]; error: string | null }> {
  const replied = (line: string) => ({ outcome: 'REPLIED' as Outcome, jobIds: [], lines: [line], error: null })
  if (!text) return replied(REPLY_OTHER)
  if (!llm) return { outcome: 'ERROR', jobIds: [], lines: [REPLY_NOT_READ], error: NO_KEY }
  let intent
  try {
    intent = await parseLarkIntent(text, { ...llm, now })
  } catch (e) {
    return { outcome: 'ERROR', jobIds: [], lines: [REPLY_NOT_READ], error: errText(e) }
  }
  if (intent.scope === 'OUT_OF_SCOPE') return replied(REPLY_OUT_OF_SCOPE)
  if (intent.scope === 'UNCLEAR') return replied(REPLY_UNCLEAR)
  if (intent.kind === 'OTHER') return replied(REPLY_OTHER)

  const refs = await resolveTaskRefs(intent.lineKeys, text)
  if (refs.tasks.length === 0 && refs.ambiguous.length === 0) return replied(REPLY_UNCLEAR)
  const lines = refs.ambiguous.map(a => replyAmbiguous(a.ref, a.candidates))
  const jobIds: string[] = []
  const errors: string[] = []
  const instruction = intent.instruction.trim()
  for (const task of refs.tasks) {
    try {
      const r = await requestForTask(intent.kind, task, instruction, sender)
      if (r.jobId && !jobIds.includes(r.jobId)) jobIds.push(r.jobId)
      lines.push(r.reply)
      if (r.error) errors.push(r.error)
    } catch (e) {
      if (e instanceof AgentJobError) { lines.push(`${task.taskKey}: ${e.message}`); continue }
      errors.push(`${task.taskKey}: ${errText(e)}`)
      lines.push(`${task.taskKey}: Lỗi máy chủ, thử lại sau.`)
    }
  }
  return { outcome: jobIds.length ? 'JOB' : 'REPLIED', jobIds, lines, error: errors.length ? errors.join('; ') : null }
}

export async function processLarkMessage(msg: AcceptedLarkMessage, deps: Partial<LarkDeps> = {}): Promise<Processed> {
  let lark: LarkApi | null = deps.lark ?? null
  try {
    lark ??= larkApi(await getLarkConfig())
    return await handleLarkMessage(msg, lark, deps)
  } catch (e) {
    const error = errText(e)
    console.error('[lark] xử lý lỗi', error)
    const reply = lark ? await lark.reply(msg.messageId, REPLY_FAILED).then(() => REPLY_FAILED, () => null) : null
    await record(msg.eventId, { outcome: 'ERROR', jobIds: [], reply, error })
    return { outcome: 'ERROR', jobIds: [], reply }
  }
}

async function handleLarkMessage(msg: AcceptedLarkMessage, lark: LarkApi, deps: Partial<LarkDeps>): Promise<Processed> {
  let llm: LarkLlm | null = null
  let llmError: string | null = null
  if ('llm' in deps) llm = deps.llm ?? null
  else {
    try { llm = await larkLlm() } catch (e) { llmError = errText(e) }
  }

  const botId = await lark.botOpenId().catch(() => null)
  if (botId && !msg.mentions.some(m => m.openId === botId)) {
    await record(msg.eventId, { outcome: 'IGNORED', jobIds: [], reply: null, error: null })
    return { outcome: 'IGNORED', jobIds: [], reply: null }
  }

  const text = stripMentions(msg.text, msg)
  const sender = (await lark.userName(msg.senderOpenId).catch(() => null)) || `Lark ${msg.senderOpenId.slice(-6)}`
  const decided = llmError && text
    ? { outcome: 'ERROR' as Outcome, jobIds: [], lines: [REPLY_NOT_READ], error: llmError }
    : await decide(text, sender, llm, deps.now)
  const reply = decided.lines.join('\n')
  let error = decided.error
  try {
    await lark.reply(msg.messageId, reply)
  } catch (e) {
    error = [error, errText(e)].filter(Boolean).join('; ')
  }
  await record(msg.eventId, { senderName: sender, outcome: decided.outcome, jobIds: decided.jobIds, reply, error })
  return { outcome: decided.outcome, jobIds: decided.jobIds, reply }
}
