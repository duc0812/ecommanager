import { prisma } from '@/lib/db'
import { retryOnBusy } from '@/lib/sqlite-busy'
import { CoverageError, LOCAL_COVERAGE_KEY, coverageHash, coverageScope, mergeCoverage, readCoverageSnapshot, scopedCoverage, validateCoverageEntries } from '@/lib/artwork-library-coverage'

export async function getLibraryCoverage(input: unknown) {
  const scope = coverageScope(input)
  const row = await prisma.appSetting.findUnique({ where: { key: LOCAL_COVERAGE_KEY } })
  const entries = scopedCoverage(readCoverageSnapshot(row?.value ?? null).entries, scope)
  return { ...scope, entries, hash: coverageHash(entries) }
}

/** Publish one product's office-library coverage through the application, preserving every other product. */
export async function publishLibraryCoverage(input: unknown) {
  const scope = coverageScope(input)
  const body = input as Record<string, unknown>
  if (typeof body.expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(body.expectedHash)) throw new CoverageError('expectedHash không hợp lệ')
  const entries = validateCoverageEntries(body.entries, scope)
  const templateIds = Array.from(new Set(entries.map(e => e.printTemplateId)))
  return retryOnBusy(() => prisma.$transaction(async tx => {
    const store = await tx.shopifyStore.findUnique({ where: { id: scope.storeId }, select: { id: true } })
    const profile = await tx.productProfile.findUnique({ where: { storeId_shopifyProductId: scope }, select: { printTemplateId: true } })
    const line = await tx.orderLine.findFirst({ where: { shopifyProductId: scope.shopifyProductId, order: { storeId: scope.storeId } }, select: { id: true } })
    if (!store || (!profile && !line)) throw new CoverageError('Không tìm thấy sản phẩm', 404)
    const templates = await tx.printTemplate.findMany({ where: { id: { in: templateIds } }, select: { id: true } })
    if (templates.length !== templateIds.length) throw new CoverageError('Template không còn tồn tại', 409)
    if (profile?.printTemplateId && templateIds.some(id => id !== profile.printTemplateId)) throw new CoverageError('Entry khác template đang gắn cho sản phẩm', 409)
    const row = await tx.appSetting.findUnique({ where: { key: LOCAL_COVERAGE_KEY } })
    const next = mergeCoverage(row?.value ?? null, scope, entries, body.expectedHash as string, new Date().toISOString())
    const value = JSON.stringify(next)
    if (row) {
      const saved = await tx.appSetting.updateMany({ where: { key: LOCAL_COVERAGE_KEY, value: row.value }, data: { value } })
      if (saved.count !== 1) throw new CoverageError('Thư viện vừa được đồng bộ ở nơi khác; thử lại sau khi đọc lại', 409)
    } else {
      try { await tx.appSetting.create({ data: { key: LOCAL_COVERAGE_KEY, value } }) }
      catch (e: any) { if (e?.code === 'P2002') throw new CoverageError('Thư viện vừa được tạo ở nơi khác; đọc lại', 409); throw e }
    }
    return { ...scope, entries, hash: coverageHash(entries), updatedAt: next.updatedAt }
  }))
}
