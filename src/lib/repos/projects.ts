import { prisma } from '@/lib/db'

export type ProjectListOptions = { includeArchived?: boolean }

export async function listProjects(opts: ProjectListOptions = {}) {
  return prisma.project.findMany({
    where: opts.includeArchived ? {} : { archivedAt: null },
    orderBy: { createdAt: 'desc' },
    include: { shopifyStore: { select: { shop: true } } },
  })
}

export async function getProjectById(id: string, opts: ProjectListOptions = {}) {
  return prisma.project.findFirst({
    where: { id, ...(opts.includeArchived ? {} : { archivedAt: null }) },
    include: { shopifyStore: true },
  })
}

export async function archiveProject(id: string) {
  return prisma.project.update({
    where: { id },
    data: { archivedAt: new Date() },
  })
}

export async function unarchiveProject(id: string) {
  return prisma.project.update({
    where: { id },
    data: { archivedAt: null },
  })
}

export async function getProjectByStoreShop(shop: string) {
  const store = await prisma.shopifyStore.findUnique({
    where: { shop },
    include: { project: true },
  })
  return store?.project ?? null
}
