import { NextRequest, NextResponse } from 'next/server'
import { requireApiAccess } from '@/lib/api-auth'
import { CreativeInputError, deleteJob, jobView, refreshJob } from '@/lib/creative/jobs'
import { loadProviders } from '@/lib/creative/providers'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireApiAccess(req)
  if ('error' in auth) return auth.error
  try {
    const job = await refreshJob(params.id, await loadProviders())
    return NextResponse.json({ job: jobView(job) })
  } catch (err: any) {
    if (err instanceof CreativeInputError) return NextResponse.json({ error: err.message }, { status: 404 })
    return NextResponse.json({ error: String(err?.message ?? err) }, { status: 502 })
  }
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireApiAccess(req)
  if ('error' in auth) return auth.error
  await deleteJob(params.id)
  return NextResponse.json({ ok: true })
}
