import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser } from '@/lib/api-auth'
import { CreativeInputError, createJob, jobView, listJobs } from '@/lib/creative/jobs'
import { loadProviders } from '@/lib/creative/providers'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams
  const jobs = await listJobs({ provider: q.get('provider') ?? undefined, model: q.get('model') ?? undefined, status: q.get('status') ?? undefined, take: Number(q.get('take') ?? 100) })
  return NextResponse.json({ jobs: jobs.map(jobView) })
}

export async function POST(req: NextRequest) {
  const user = await getAuthUser(req)
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Body không hợp lệ' }, { status: 400 })
  const images = Array.isArray(body.images) ? body.images.filter((i: any) => typeof i?.dataUrl === 'string').map((i: any) => ({ dataUrl: String(i.dataUrl), name: String(i.name ?? 'image') })) : []
  const options: Record<string, string> = {}
  if (body.options && typeof body.options === 'object') for (const [k, v] of Object.entries(body.options)) if (typeof v === 'string' && v) options[k] = v
  try {
    const job = await createJob({ provider: body.provider, model: String(body.model ?? ''), prompt: String(body.prompt ?? ''), images, options, userId: user?.id }, await loadProviders())
    return NextResponse.json({ job: jobView(job) })
  } catch (err: any) {
    if (err instanceof CreativeInputError) return NextResponse.json({ error: err.message }, { status: 400 })
    return NextResponse.json({ error: String(err?.message ?? err) }, { status: 502 })
  }
}
