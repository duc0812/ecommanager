import { NextRequest, NextResponse } from 'next/server'
import { listDesignEntries, upsertDesignEntry } from '@/lib/repos/design-library'
import { reevaluateOrdersForDesignEntry } from '@/lib/repos/design-reeval'

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const readyParam = sp.get('ready')
  const entries = await listDesignEntries({
    supplierId: sp.get('supplierId') ?? undefined,
    sku: sp.get('sku') ?? undefined,
    ready: readyParam == null ? undefined : readyParam === 'true',
    source: sp.get('source') ?? undefined,
  })
  return NextResponse.json({ entries })
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  if (!body.sku || !body.supplierId) {
    return NextResponse.json({ error: 'sku and supplierId are required' }, { status: 400 })
  }
  const entry = await upsertDesignEntry({
    sku: String(body.sku).trim(),
    supplierId: String(body.supplierId),
    designLink: body.designLink ?? null,
    ready: typeof body.ready === 'boolean' ? body.ready : undefined,
    note: body.note ?? null,
    source: 'MANUAL',
    matchMode: body.matchMode !== undefined ? String(body.matchMode).toUpperCase() : undefined,
    designType: body.designType !== undefined ? String(body.designType) : undefined,
  })
  // Re-sync existing orders that use this design against the just-saved library entry.
  const resynced = await reevaluateOrdersForDesignEntry({
    sku: entry.sku, supplierId: entry.supplierId, matchMode: entry.matchMode,
  })
  return NextResponse.json({ entry, resynced })
}
