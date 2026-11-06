import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { jsonBody, scaleError, staff } from '@/lib/scale/http'
import { createScaleJob, listScaleJobs, scaleJobView } from '@/lib/scale/jobs'
import { getScaleSettings, loadScaleDeps } from '@/lib/scale/settings'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const auth = await staff(req)
  if ('error' in auth) return auth.error
  const [jobs, settings] = await Promise.all([listScaleJobs(), getScaleSettings()])
  const ids = Array.from(new Set(jobs.map(j => j.createdBy).filter((x): x is string => !!x)))
  const users = ids.length ? await prisma.appUser.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : []
  const names: Record<string, string> = Object.fromEntries(users.map(u => [u.id, u.name]))
  return NextResponse.json({
    jobs: jobs.map(j => ({ ...scaleJobView(j), createdByName: j.createdBy ? names[j.createdBy] ?? null : null })),
    allowFallback: settings.allowFallback,
  })
}

export async function POST(req: NextRequest) {
  const auth = await staff(req)
  if ('error' in auth) return auth.error
  const body = await jsonBody(req)
  try {
    const job = await createScaleJob({ targetId: String(body.targetId ?? ''), image: { dataUrl: String(body.image?.dataUrl ?? ''), name: String(body.image?.name ?? 'image') }, userId: auth.user.id }, await loadScaleDeps())
    return NextResponse.json({ job: { ...scaleJobView(job), createdByName: auth.user.name } })
  } catch (err) { return scaleError(err) }
}
