import { prisma } from '@/lib/db'
import { matchDesignEntry } from '@/lib/design-parent'
import { isLineCustomized } from '@/lib/order-classify'
import { extractPreviewCdnUrl } from '@/lib/order-line-assets'
import { PublicUrlError } from '@/lib/public-artwork'
import { factoryLinkFor, joinDesignLinks, lazyPublicBase } from '@/lib/design-links'
import { folderHoldsPrintFiles, orderedPrintFiles } from '@/lib/task-files'

export const STUDIO_LIBRARY_SOURCE = 'STUDIO'

export type LibraryLine = {
  orderId: string; shopifyLineId: string; sku: string | null; resolvedSupplierId: string | null
  customized: boolean; customAttributesJson: string | null; previewCdnUrl: string | null
}

function parseAttrs(json: string | null): Array<{ key: string; value: string }> | null {
  if (json == null) return null
  try {
    const raw = JSON.parse(json)
    return Array.isArray(raw) ? raw.filter(a => a && typeof a.key === 'string' && typeof a.value === 'string') : null
  } catch { return null }
}

/** Same rule the order sync uses before it links a missing design to a Trello card: a customized line never feeds the library. */
export function isReusableDesignLine(line: LibraryLine): boolean {
  if (!line.sku || !line.resolvedSupplierId || line.customized) return false
  const attrs = parseAttrs(line.customAttributesJson)
  if (!attrs) return true
  return !isLineCustomized({ customAttributes: attrs, previewCdnUrl: line.previewCdnUrl ?? extractPreviewCdnUrl(attrs) })
}

export type LibrarySaveResult = { saved: boolean; designLink: string | null; note: string | null }

/**
 * After a non-customized line is approved in Design Studio, the approved files become the library design of its SKU × supplier,
 * so the next order of that SKU needs no task — what the Trello sync does for a card in the Done list.
 * The library gets a link the factory can open: the task folder once it holds every print file, else one link per print part
 * (the Drive link, or the public URL while the file is still local) — the Drive push turns those into the folder link later.
 */
export async function saveStudioDesignToLibrary(line: LibraryLine, slots: string[]): Promise<LibrarySaveResult> {
  if (!isReusableDesignLine(line)) return { saved: false, designLink: null, note: null }
  const [files, task] = await Promise.all([
    prisma.designArtwork.findMany({ where: { orderId: line.orderId, shopifyLineId: line.shopifyLineId } }),
    prisma.designTask.findUnique({ where: { orderId_shopifyLineId: { orderId: line.orderId, shopifyLineId: line.shopifyLineId } }, select: { driveFolderUrl: true } }),
  ])
  const picked = orderedPrintFiles(files.filter(a => !a.removedAt), slots)
  if (picked.length === 0) return { saved: false, designLink: null, note: null }

  let designLink: string
  if (task?.driveFolderUrl && folderHoldsPrintFiles(files)) {
    designLink = task.driveFolderUrl
  } else {
    try {
      const publicBase = lazyPublicBase()
      const links: Array<{ url: string }> = []
      for (const p of picked) links.push(await factoryLinkFor(p, publicBase))
      designLink = joinDesignLinks(links)
    } catch (e: any) {
      if (!(e instanceof PublicUrlError)) throw e
      return { saved: false, designLink: null, note: `Chưa lưu vào Design Library (đơn sau cùng SKU sẽ tạo task mới): ${e.message}` }
    }
  }

  const supplierId = line.resolvedSupplierId as string
  const sku = line.sku as string
  const entries = await prisma.skuSupplierDesign.findMany({
    where: { supplierId },
    select: { id: true, sku: true, supplierId: true, matchMode: true, designLink: true, designType: true },
  })
  const match = matchDesignEntry(sku, supplierId, entries) as (typeof entries)[number] | null
  if (match) {
    await prisma.skuSupplierDesign.update({ where: { id: match.id }, data: { designLink, ready: true, source: STUDIO_LIBRARY_SOURCE } })
  } else {
    await prisma.skuSupplierDesign.upsert({
      where: { sku_supplierId: { sku, supplierId } },
      create: { sku, supplierId, designLink, ready: true, source: STUDIO_LIBRARY_SOURCE, matchMode: 'VARIANT', designType: 'NON_CUSTOM' },
      update: { designLink, ready: true, source: STUDIO_LIBRARY_SOURCE },
    })
  }
  return { saved: true, designLink, note: null }
}
