import { prisma } from '@/lib/db'
import type { AcceptedLarkMessage } from '@/lib/lark/events'
import { larkApi, type LarkApi } from '@/lib/lark/api'
import { getLarkConfig } from '@/lib/lark/settings'
import { larkLlm, readLarkIntent, type LarkIntent, type LarkLlm } from '@/lib/lark/intent'
import { resolveTaskRefs } from '@/lib/lark/resolve'
import {
  AGENT_HOLDER, REPLY_FAILED, REPLY_LIST_CAP, REPLY_NOTED, REPLY_NOT_READ, REPLY_OTHER, REPLY_OUT_OF_SCOPE, REPLY_SENT, REPLY_UNCLEAR, SHORT_REASON,
  replyAccepted, replyAmbiguous, replyAppended, replyAskCustomer, replyCancelled, replyGrouped, replyHeldBefore, replyOrderClosed, replyRunning,
  replyWhatToFix, type GroupedLines,
} from '@/lib/lark/replies'
import { describeWorkState, larkTaskStatus, minutesLeft } from '@/lib/lark/status'
import { larkUnassignedReport } from '@/lib/lark/unassigned'
import { REPLY_ONE_LINE_ONLY, changeSupplierFromLark, undoSupplierFromLark } from '@/lib/lark/supplier-change'
import { AgentJobBusy, AgentJobError, enqueueAgentJob, type AgentJobKind } from '@/lib/design-agent/jobs'
import { agentAddNote, agentRejectReview, agentReopenTask, type AgentTaskState } from '@/lib/design-agent/delivery'
import { workHolder, workStateFor, type WorkState } from '@/lib/design-agent/work-state'

export type LarkDeps = { lark: LarkApi; llm: LarkLlm | null; now?: Date }
type Outcome = 'JOB' | 'REPLIED' | 'IGNORED' | 'ERROR'
type Processed = { outcome: Outcome; jobIds: string[]; reply: string | null }

const NO_KEY = 'Chưa có API key cho Claude'
const FIX_FROM = ['REJECTED', 'NEW', 'ASSIGNED', 'DOING']
const MAX_ERROR = 1000

const errText = (e: unknown) => String((e as Error)?.message ?? e).slice(0, MAX_ERROR)

/** `held`: what to add to an accepted reply when the line was held in the local queue before. */
type Enqueue = { accepted?: boolean; held?: string }

/** Where the line goes in the one reply sent for a list of lines. */
type Placed =
  | { group: 'ACCEPTED' }
  | { group: 'HELD'; holder: string; minutes?: number | null }
  | { group: 'REFUSED'; why: string }
type Requested = { jobId: string | null; reply: string; error?: string; placed: Placed }

async function enqueueFor(kind: AgentJobKind, task: AgentTaskState, instruction: string, sender: string, opts: Enqueue = {}): Promise<Requested> {
  const { job, created, appended } = await enqueueAgentJob({
    kind, source: 'LARK', taskKey: task.taskKey, requestText: `Yêu cầu từ Lark (${sender}): ${instruction}`, requestedBy: sender,
  })
  const acceptedReply = () => replyAccepted(task.taskKey) + (opts.held ?? '')
  if (created) return { jobId: job.id, reply: acceptedReply(), placed: { group: 'ACCEPTED' } }
  if (appended) return { jobId: job.id, reply: opts.accepted ? acceptedReply() : replyAppended(task.taskKey), placed: { group: 'ACCEPTED' } }
  await agentAddNote(task.taskKey, `Lark – ${sender}: ${instruction}`)
  return { jobId: null, reply: replyRunning(task.taskKey), placed: { group: 'HELD', holder: AGENT_HOLDER } }
}

function closedReply(key: string, reason: Extract<WorkState, { kind: 'CLOSED' }>['reason']): string {
  if (reason === 'CANCELLED') return replyCancelled(key)
  if (reason === 'ORDER_CLOSED') return replyOrderClosed(key)
  if (reason === 'ASK_CUSTOMER') return replyAskCustomer(key)
  return REPLY_SENT
}

/** A line another worker keeps; with nobody to name (stale board) it is refused, never shown as free. */
function placedBusy(state: WorkState, now: Date): Placed {
  const holder = workHolder(state)
  if (!holder) return { group: 'REFUSED', why: SHORT_REASON.HOLDER_UNKNOWN }
  return { group: 'HELD', holder, minutes: state.kind === 'QUEUE' ? minutesLeft(state.etaAt, now) : null }
}

export async function requestForTask(
  kind: 'FIX' | 'NEW_DESIGN' | 'MOCKUP', task: AgentTaskState, instruction: string, sender: string, now: Date = new Date(),
): Promise<Requested> {
  const key = task.taskKey
  const state = await workStateFor(task, now)
  if (state.kind === 'CLOSED') return { jobId: null, reply: closedReply(key, state.reason), placed: { group: 'REFUSED', why: SHORT_REASON[state.reason] } }
  if (state.kind !== 'AGENT' && state.kind !== 'FREE') {
    // Another worker keeps the line (or nobody can tell): the request is kept as a note and the task is left as it is.
    const text = instruction.trim()
    if (text) await agentAddNote(key, `Lark – ${sender}: ${text}`)
    return { jobId: null, reply: describeWorkState(key, state, now) + (text ? REPLY_NOTED : ''), placed: placedBusy(state, now) }
  }
  const held = state.kind === 'FREE' && state.heldReason ? replyHeldBefore(state.heldReason) : ''
  if (kind === 'MOCKUP') return enqueueFor('MOCKUP', task, instruction, sender, { held })
  if (kind === 'NEW_DESIGN' && (task.status === 'NEW' || task.status === 'ASSIGNED')) return enqueueFor('MAKE', task, instruction, sender, { held })
  if (instruction.trim().length < 3) return { jobId: null, reply: replyWhatToFix(key), placed: { group: 'REFUSED', why: SHORT_REASON.WHAT_TO_FIX } }
  if (FIX_FROM.includes(task.status)) return enqueueFor('FIX', task, instruction, sender, { held })
  if (state.kind === 'AGENT' && state.status === 'RUNNING') return enqueueFor('FIX', task, instruction, sender)
  const note = `Theo yêu cầu của ${sender} trên Lark`
  if (task.status === 'REVIEW') {
    await agentRejectReview(key, { reason: `Khác: ${instruction.trim().slice(0, 200)}`, note })
    return enqueueAfterMove(task, instruction, sender, { did: 'trả lại', after: 'trả lại sửa' }, { accepted: true, held })
  }
  if (task.status === 'DONE') {
    await agentReopenTask(key, { note }, { allowSent: false })
    return enqueueAfterMove(task, instruction, sender, { did: 'mở lại', after: 'mở lại để sửa' }, { held })
  }
  return enqueueFor('FIX', task, instruction, sender, { held })
}

async function enqueueAfterMove(
  task: AgentTaskState, instruction: string, sender: string, move: { did: string; after: string }, opts: Enqueue = {},
): Promise<Requested> {
  try {
    return await enqueueFor('FIX', task, instruction, sender, opts)
  } catch (e) {
    const error = `${task.taskKey}: ${errText(e)}`
    await agentAddNote(task.taskKey, `không xếp được việc sau khi ${move.after} theo yêu cầu Lark; cần xếp lại`)
      .catch(n => console.error('[lark] chưa ghi được ghi chú', errText(n)))
    const reply = `${task.taskKey}: đã ${move.did} task nhưng chưa xếp được việc cho Agent — hãy xếp lại trên tool.`
    return { jobId: null, reply, error, placed: { group: 'REFUSED', why: SHORT_REASON.NOT_QUEUED } }
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

type Decided = { outcome: Outcome; jobIds: string[]; lines: string[]; error: string | null }
const replied = (line: string): Decided => ({ outcome: 'REPLIED', jobIds: [], lines: [line], error: null })

async function decide(text: string, sender: string, llm: LarkLlm | null, now?: Date): Promise<Decided> {
  if (!text) return replied(REPLY_OTHER)
  if (!llm) return { outcome: 'ERROR', jobIds: [], lines: [REPLY_NOT_READ], error: NO_KEY }
  let read
  try {
    read = await readLarkIntent(text, { ...llm, now })
  } catch (e) {
    return { outcome: 'ERROR', jobIds: [], lines: [REPLY_NOT_READ], error: errText(e) }
  }
  const { intent } = read
  if (intent.scope === 'OUT_OF_SCOPE') return replied(REPLY_OUT_OF_SCOPE)
  if (intent.scope === 'UNCLEAR') return replied(REPLY_UNCLEAR)
  if (intent.kind === 'OTHER') return replied(REPLY_OTHER)
  const at = now ?? new Date()
  if (intent.kind === 'UNASSIGNED_REPORT') return replied(await larkUnassignedReport(at))

  const decided = await decideForLines(intent.kind, intent, text, sender, at)
  if (read.over) decided.lines.push(REPLY_LIST_CAP)
  return decided
}

type LineKind = Exclude<LarkIntent['kind'], 'OTHER' | 'UNASSIGNED_REPORT'>

async function decideForLines(kind: LineKind, intent: LarkIntent, text: string, sender: string, at: Date): Promise<Decided> {
  const refs = await resolveTaskRefs(intent.lineKeys, text)
  if (refs.tasks.length === 0 && refs.ambiguous.length === 0) return replied(REPLY_UNCLEAR)
  if (kind === 'SUPPLIER_CHANGE' || kind === 'SUPPLIER_UNDO') {
    // One line per message, and only when every code in it was understood: a supplier write is never a guess.
    if (refs.tasks.length + refs.ambiguous.length + refs.unknown.length > 1) return replied(REPLY_ONE_LINE_ONLY)
    if (refs.ambiguous.length) return replied(replyAmbiguous(refs.ambiguous[0].ref, refs.ambiguous[0].candidates))
    const task = refs.tasks[0]
    try {
      const r: { reply: string; error?: string } = kind === 'SUPPLIER_CHANGE'
        ? await changeSupplierFromLark({ task, supplierName: intent.supplierName, supplierSku: intent.supplierSku, instruction: intent.instruction, sender }, at)
        : await undoSupplierFromLark({ task, sender })
      return { outcome: 'REPLIED', jobIds: [], lines: [r.reply], error: r.error ?? null }
    } catch (e) {
      return { outcome: 'REPLIED', jobIds: [], lines: [`${task.taskKey}: Lỗi máy chủ, thử lại sau.`], error: `${task.taskKey}: ${errText(e)}` }
    }
  }
  const lines = refs.ambiguous.map(a => replyAmbiguous(a.ref, a.candidates))
  if (kind === 'STATUS') {
    for (const task of refs.tasks) lines.push(await larkTaskStatus(task, at))
    return { outcome: 'REPLIED', jobIds: [], lines, error: null }
  }
  const jobIds: string[] = []
  const errors: string[] = []
  const grouped: GroupedLines = { accepted: [], held: [], refused: [], unknown: refs.unknown, ambiguous: refs.ambiguous }
  const place = (key: string, placed: Placed) => {
    if (placed.group === 'ACCEPTED') grouped.accepted.push(key)
    else if (placed.group === 'HELD') grouped.held.push({ key, holder: placed.holder, minutes: placed.minutes })
    else grouped.refused.push({ key, why: placed.why })
  }
  const instruction = intent.instruction.trim()
  for (const task of refs.tasks) {
    try {
      const r = await requestForTask(kind, task, instruction, sender, at)
      if (r.jobId && !jobIds.includes(r.jobId)) jobIds.push(r.jobId)
      lines.push(r.reply)
      place(task.taskKey, r.placed)
      if (r.error) errors.push(r.error)
    } catch (e) {
      if (e instanceof AgentJobError) {
        lines.push(`${task.taskKey}: ${e.message}`)
        place(task.taskKey, e instanceof AgentJobBusy ? placedBusy(e.state, at) : { group: 'REFUSED', why: e.message })
        continue
      }
      errors.push(`${task.taskKey}: ${errText(e)}`)
      lines.push(`${task.taskKey}: Lỗi máy chủ, thử lại sau.`)
      place(task.taskKey, { group: 'REFUSED', why: SHORT_REASON.SERVER_ERROR })
    }
  }
  // Several lines in one message: one grouped reply, so a list of 14 does not become 14 sentences in the group.
  const many = refs.tasks.length + refs.ambiguous.length + refs.unknown.length > 1
  return { outcome: jobIds.length ? 'JOB' : 'REPLIED', jobIds, lines: many ? [replyGrouped(grouped)] : lines, error: errors.length ? errors.join('; ') : null }
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
