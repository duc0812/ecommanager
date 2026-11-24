import type { Prisma } from '@/generated/prisma/client'

// A returned outsource task stays with dispatch until an internal owner or a new external assignment takes it.
export const availableForAutomation: Prisma.DesignTaskWhereInput = {
  OR: [
    { outsource: null },
    { outsource: { active: false }, NOT: { status: 'REJECTED', assigneeId: null } },
  ],
}

export async function closeReturnedAssignment(tx: Prisma.TransactionClient, taskId: string) {
  const closed = await tx.designOutsource.updateMany({
    where: { taskId, active: true },
    data: { active: false, revision: { increment: 1 } },
  })
  return closed.count ? { assigneeId: null, prevStatus: null } : {}
}
