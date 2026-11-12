import { prisma } from '@/lib/db'
import type { Actor } from '@/lib/design-tasks'
import { isUniqueViolation } from '@/lib/sqlite-busy'

export const AGENT_USER_EMAIL = 'design-agent@ecom-manager.local'
export const AGENT_USER_NAME = 'Design Agent'

const PERMISSIONS = JSON.stringify(['design_tasks'])
// INACTIVE with no password: the account only signs events, it can never log in and is never offered in "Giao việc".
const SHAPE = { name: AGENT_USER_NAME, role: 'SUPPORT', permissions: PERMISSIONS, status: 'INACTIVE', passwordHash: null }

function actorOf(id: string): Actor {
  return { id, name: AGENT_USER_NAME, role: 'SUPPORT', permissions: ['design_tasks'] }
}

export async function ensureAgentUser(): Promise<Actor> {
  const found = await prisma.appUser.findUnique({ where: { email: AGENT_USER_EMAIL } })
  if (found && found.name === SHAPE.name && found.role === SHAPE.role && found.permissions === SHAPE.permissions && found.status === SHAPE.status && found.passwordHash === null) {
    return actorOf(found.id)
  }
  try {
    const row = await prisma.appUser.upsert({ where: { email: AGENT_USER_EMAIL }, create: { email: AGENT_USER_EMAIL, ...SHAPE }, update: SHAPE })
    return actorOf(row.id)
  } catch (e) {
    if (!isUniqueViolation(e)) throw e
    return actorOf((await prisma.appUser.findUniqueOrThrow({ where: { email: AGENT_USER_EMAIL } })).id)
  }
}
