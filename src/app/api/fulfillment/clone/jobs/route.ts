import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAccess } from '@/lib/api-auth'
import { storeScopeFor } from '@/lib/store-scope'
import { listConnectedStores } from '@/lib/store-connections'
import { cloneJobView, createCloneJob, listCloneJobs } from '@/lib/clone/jobs'
import { getCloneSettings } from '@/lib/clone/settings'
import { parseSkuPrefix } from '@/lib/clone/sku-code'
import { cloneWorkerInfo } from '@/lib/clone/worker'
import { badRequest, cloneErrorResponse, isJsonObject, readJson } from '@/lib/clone/route-http'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const auth = await requireApiAccess(req)
  if ('error' in auth) return auth.error
  const { user } = auth
  const [jobs, scope, connected, owner, settings, worker] = await Promise.all([
    listCloneJobs(user),
    storeScopeFor(user),
    listConnectedStores(),
    prisma.appUser.findUnique({ where: { id: user.id }, select: { skuPrefix: true } }),
    getCloneSettings(),
    cloneWorkerInfo(),
  ])
  const stores = connected
    .filter(s => scope.all || scope.storeIds.includes(s.id))
    .map(s => ({ id: s.id, shop: s.shop, orderPrefix: s.orderPrefix }))
  return NextResponse.json({
    jobs,
    worker: { online: worker.online, lastSeenAt: worker.lastSeenAt },
    stores,
    hasSkuPrefix: parseSkuPrefix(owner?.skuPrefix) !== null,
    paused: settings.paused,
  })
}

export async function POST(req: NextRequest) {
  const auth = await requireApiAccess(req)
  if ('error' in auth) return auth.error
  const body = await readJson(req)
  if (!isJsonObject(body)) return badRequest()
  try {
    const row = await createCloneJob(auth.user, { url: body.url, storeId: body.storeId, force: body.force })
    return NextResponse.json({ job: cloneJobView(row, auth.user) }, { status: 201 })
  } catch (e) {
    return cloneErrorResponse(e)
  }
}
