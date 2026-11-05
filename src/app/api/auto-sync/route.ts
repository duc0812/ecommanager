import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { autoSyncResultKey, runAutoSync } from '@/lib/auto-sync'
import { projectRowsWhere, requireFinanceScope } from '@/lib/finance-scope'

// A caller limited to some stores reads, and runs, the sync for those stores and their ad accounts only.
export async function GET(req: NextRequest) {
  const scope = await requireFinanceScope(req, 'projects')
  if ('error' in scope) return scope.error
  try {
    const setting = await prisma.appSetting.findUnique({
      where: { key: autoSyncResultKey(scope.storeIds) },
    })
    const lastResult = setting?.value ? JSON.parse(setting.value) : null
    return NextResponse.json({ status: 'idle', lastResult })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const scope = await requireFinanceScope(req, 'projects')
  if ('error' in scope) return scope.error
  try {
    const accounts = scope.storeIds
      ? await prisma.metaAdAccount.findMany({ where: projectRowsWhere(scope), select: { id: true }, orderBy: { createdAt: 'asc' } })
      : []
    const result = await runAutoSync(
      req.nextUrl.origin,
      req.headers.get('cookie'),
      scope.storeIds ? { storeIds: scope.storeIds, accountIds: accounts.map(a => a.id) } : null,
    )
    return NextResponse.json({ success: true, result })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
