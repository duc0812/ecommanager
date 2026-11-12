import { prisma } from '@/lib/db'
import { agentTaskState, type AgentTaskState } from '@/lib/design-agent/delivery'

type Resolved = { tasks: AgentTaskState[]; ambiguous: { ref: string; candidates: string[] }[]; unknown: string[] }

const REF = /^([A-Z]*)(\d+)(?:_(\d+))?$/
const ORDER_NO = /^#?([A-Za-z]+)(\d+)$/
const MIN_DIGITS_ALONE = 4
const MAX_SUFFIX_ROWS = 200

function normalise(ref: string): string {
  return ref.trim().replace(/^#/, '').replace(/\s+/g, '').toUpperCase()
}

function digitsInText(digits: string, text: string): boolean {
  const runs: string[] = text.match(/\d+/g) ?? []
  return runs.includes(digits)
}

async function ordersFor(letters: string, digits: string): Promise<{ id: string; name: string }[]> {
  const rows = letters
    ? await prisma.order.findMany({ where: { shopifyOrderNumber: { in: [`#${letters}${digits}`, `${letters}${digits}`] } }, select: { id: true, shopifyOrderNumber: true } })
    : digits.length < MIN_DIGITS_ALONE
      ? []
      : await prisma.order.findMany({
        where: { shopifyOrderNumber: { endsWith: digits } }, select: { id: true, shopifyOrderNumber: true },
        orderBy: { placedAt: 'desc' }, take: MAX_SUFFIX_ROWS,
      })
  return rows
    .filter(r => {
      const m = ORDER_NO.exec(r.shopifyOrderNumber)
      return !!m && m[2] === digits && (!letters || m[1].toUpperCase() === letters)
    })
    .map(r => ({ id: r.id, name: r.shopifyOrderNumber.replace(/^#/, '') }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export async function resolveTaskRefs(lineKeys: string[], text: string): Promise<Resolved> {
  const out: Resolved = { tasks: [], ambiguous: [], unknown: [] }
  const refs = Array.from(new Set(lineKeys.map(normalise).filter(Boolean)))
  const seen = new Set<string>()
  const addTask = (t: AgentTaskState) => { if (!seen.has(t.taskKey)) { seen.add(t.taskKey); out.tasks.push(t) } }

  for (const ref of refs) {
    const m = REF.exec(ref)
    if (!m || !digitsInText(m[2], text)) { out.unknown.push(ref); continue }
    const [, letters, digits, line] = m
    const orders = await ordersFor(letters, digits)
    if (orders.length === 0) { out.unknown.push(ref); continue }
    if (orders.length > 1) {
      out.ambiguous.push({ ref, candidates: orders.map(o => (line ? `${o.name}_${line}` : o.name)) })
      continue
    }
    const order = orders[0]
    if (line) {
      const state = await agentTaskState(`${order.name}_${Number(line)}`)
      if (state && state.orderId === order.id) addTask(state)
      else out.unknown.push(ref)
      continue
    }
    const tasks = await prisma.designTask.findMany({
      where: { orderId: order.id, status: { not: 'CANCELLED' } }, select: { taskKey: true }, orderBy: { taskKey: 'asc' },
    })
    if (tasks.length === 0) { out.unknown.push(ref); continue }
    if (tasks.length > 1) { out.ambiguous.push({ ref, candidates: tasks.map(t => t.taskKey) }); continue }
    const state = await agentTaskState(tasks[0].taskKey)
    if (state) addTask(state)
    else out.unknown.push(ref)
  }
  return out
}
