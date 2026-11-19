import { prisma } from '@/lib/db'
import { replaceWorkBoard, type BoardEntryInput } from '@/lib/design-agent/work-board'

export async function dropWorkBoard(): Promise<void> {
  await prisma.workBoardEntry.deleteMany({})
  await prisma.appSetting.deleteMany({ where: { key: { in: ['design.board.publishedAt', 'design.board.rejectedOwner'] } } })
}

export function publishBoard(entries: BoardEntryInput[] = [], rejectedOwner: string | null = null, now: Date = new Date()) {
  return replaceWorkBoard({ entries, rejectedOwner }, now)
}
