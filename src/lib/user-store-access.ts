import { prisma } from '@/lib/db'

export const ONLY_SELLER_HAS_STORES = 'Chỉ Seller mới được giao store.'

// A list of store ids from a request body: every one must be a real store. A repeated id counts once.
export async function parseStoreIds(value: unknown): Promise<{ ids: string[] } | { error: string }> {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item === '')) {
    return { error: 'storeIds phải là danh sách id store.' }
  }
  const ids = Array.from(new Set(value as string[]))
  const found = await prisma.shopifyStore.findMany({ where: { id: { in: ids } }, select: { id: true } })
  const missing = ids.filter(id => !found.some(store => store.id === id))
  if (missing.length > 0) return { error: `Không có store với id: ${missing.join(', ')}` }
  return { ids }
}

export async function storeIdsOf(userId: string): Promise<string[]> {
  const rows = await prisma.userStoreAccess.findMany({ where: { userId }, select: { storeId: true }, orderBy: { storeId: 'asc' } })
  return rows.map(row => row.storeId)
}

export async function replaceStoreAccess(userId: string, storeIds: string[]) {
  if (storeIds.length === 0) {
    await prisma.userStoreAccess.deleteMany({ where: { userId } })
    return
  }
  await prisma.$transaction(async tx => {
    await tx.userStoreAccess.deleteMany({ where: { userId } })
    await tx.userStoreAccess.createMany({ data: storeIds.map(storeId => ({ userId, storeId })) })
  })
}
