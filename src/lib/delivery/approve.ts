import { prisma } from '@/lib/db'
import { verifyBearerHash } from '@/lib/hashed-token'
import { getDesignSettings } from '@/lib/design-settings'
import { transitionTask, type Actor } from '@/lib/design-tasks'
import { canApproveDesign, parsePermissions } from '@/lib/roles'

export const APPROVE_TOKEN_KEY = 'delivery.approveTokenHash'
export const LOCAL_APPROVER_KEY = 'delivery.localApprover'
export const LOCAL_APPROVE_EVENT = 'Duyệt ở máy local'
export const APPROVE_MISSING_WARNING = 'Không duyệt được: thiếu phần'

export function verifyApproveToken(header: string | null): Promise<boolean> {
  const value = (header ?? '').trim()
  if (!value) return Promise.resolve(false)
  return verifyBearerHash(/^Bearer\s/i.test(value) ? value : `Bearer ${value}`, APPROVE_TOKEN_KEY)
}

/** The owner's account named in `delivery.localApprover`, or why approving on the local PC is off. */
export async function localApprover(): Promise<{ actor: Actor } | { error: string }> {
  const id = (await prisma.appSetting.findUnique({ where: { key: LOCAL_APPROVER_KEY } }))?.value?.trim()
  if (!id) return { error: `Chưa cài người duyệt ở máy local (${LOCAL_APPROVER_KEY})` }
  const user = await prisma.appUser.findUnique({ where: { id }, select: { id: true, name: true, role: true, status: true, permissions: true } })
  if (!user || user.status !== 'ACTIVE') return { error: 'Người duyệt ở máy local không còn hoạt động' }
  const actor: Actor = { id: user.id, name: user.name, role: user.role, permissions: parsePermissions(user.permissions) }
  if (!canApproveDesign(actor.role, actor.permissions, (await getDesignSettings()).designerCanApprove)) {
    return { error: `${user.name} không có quyền duyệt design` }
  }
  return { actor }
}

/** REVIEW → DONE through the app's own approval (every check and hook it runs), then the event that says it came from the local PC. */
export async function approveDelivered(taskKey: string): Promise<{ approved: boolean; warning?: string }> {
  const approver = await localApprover()
  if ('error' in approver) return { approved: false, warning: `Không duyệt được: ${approver.error}` }
  const task = await prisma.designTask.findUnique({ where: { taskKey }, select: { id: true } })
  if (!task) return { approved: false, warning: 'Không duyệt được: không tìm thấy task' }
  try {
    await transitionTask(taskKey, approver.actor, { to: 'DONE' })
  } catch (err: any) {
    return { approved: false, warning: `Không duyệt được: ${err?.message ?? err}` }
  }
  try {
    await prisma.designTaskEvent.create({ data: { taskId: task.id, type: 'SYSTEM', message: LOCAL_APPROVE_EVENT, actorId: approver.actor.id } })
  } catch (err: any) {
    return { approved: true, warning: `Đã duyệt nhưng chưa ghi được event "${LOCAL_APPROVE_EVENT}": ${err?.message ?? err}` }
  }
  return { approved: true }
}
