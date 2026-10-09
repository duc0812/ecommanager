import { NextRequest, NextResponse } from 'next/server'
import { requireSuperadmin } from '@/lib/api-auth'
import { generateWorkerToken, revokeWorkerToken, workerTokenInfo } from '@/lib/artwork-worker'

export async function GET() {
  return NextResponse.json(await workerTokenInfo())
}

export async function POST(req: NextRequest) {
  const auth = await requireSuperadmin(req)
  if ('error' in auth) return auth.error
  const token = await generateWorkerToken()
  return NextResponse.json({ token, ...(await workerTokenInfo()) })
}

export async function DELETE(req: NextRequest) {
  const auth = await requireSuperadmin(req)
  if ('error' in auth) return auth.error
  await revokeWorkerToken()
  return NextResponse.json(await workerTokenInfo())
}
