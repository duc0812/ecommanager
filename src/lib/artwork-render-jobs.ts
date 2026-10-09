import { prisma } from '@/lib/db'
import type { RenderJobStatus, RenderJobView } from '@/lib/artwork-render-eligibility'

export const RENDER_LINE = 'RENDER_LINE'

type JobRow = {
  id: string; status: string; attempts: number; error: string | null; createdAt: Date; finishedAt: Date | null
  resultArtworkId: string | null; printArea: string | null
}

export function renderJobView(j: JobRow): RenderJobView {
  return {
    id: j.id, status: j.status as RenderJobStatus, attempts: j.attempts, error: j.error, createdAt: j.createdAt.toISOString(),
    finishedAt: j.finishedAt?.toISOString() ?? null, artworkId: j.resultArtworkId, printArea: j.printArea,
  }
}

export async function latestRenderJob(orderId: string, shopifyLineId: string): Promise<RenderJobView | null> {
  const j = await prisma.artworkJob.findFirst({ where: { kind: RENDER_LINE, orderId, shopifyLineId }, orderBy: { createdAt: 'desc' } })
  return j ? renderJobView(j) : null
}
