import { NextRequest, NextResponse } from 'next/server'
import { requireScope } from '@/lib/order-scope'
import { listSupplierFixes } from '@/lib/design-tasks'
import { SUPPLIER_LINK_KINDS, isLineFixReason, type SupplierLinkKind } from '@/lib/line-fix'

export async function GET(req: NextRequest) {
  const scope = await requireScope(req, 'design_tasks')
  if ('error' in scope) return scope.error
  const sp = req.nextUrl.searchParams
  const reason = sp.get('reason')
  const kind = sp.get('kind')
  return NextResponse.json(await listSupplierFixes({
    storeIds: scope.storeIds,
    reason: reason === 'none' ? 'none' : isLineFixReason(reason) ? reason : null,
    supplierId: sp.get('supplier') || null,
    kind: SUPPLIER_LINK_KINDS.includes(kind as SupplierLinkKind) ? kind as SupplierLinkKind : null,
  }))
}
