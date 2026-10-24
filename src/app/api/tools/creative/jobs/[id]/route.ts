import { NextRequest, NextResponse } from 'next/server'
import { CreativeInputError, deleteJob, jobView, refreshJob } from '@/lib/creative/jobs'
import { loadProviders } from '@/lib/creative/providers'

export const dynamic = 'force-dynamic'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const job = await refreshJob(params.id, await loadProviders())
    return NextResponse.json({ job: jobView(job) })
  } catch (err: any) {
    if (err instanceof CreativeInputError) return NextResponse.json({ error: err.message }, { status: 404 })
    return NextResponse.json({ error: String(err?.message ?? err) }, { status: 502 })
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  await deleteJob(params.id)
  return NextResponse.json({ ok: true })
}
