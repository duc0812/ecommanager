import { NextRequest, NextResponse } from 'next/server'
import { agentUploadGuard } from '@/lib/design-agent/delivery'
import { ensureAgentUser } from '@/lib/design-agent/agent-user'
import { agentErrorResponse, requireRunner } from '@/lib/design-agent/route-http'
import { fileKindOf, isFileKind } from '@/lib/task-files'
import { receiveTaskArtwork } from '@/lib/task-artwork-upload'

export const dynamic = 'force-dynamic'

export async function PUT(req: NextRequest, { params }: { params: { key: string } }) {
  const denied = await requireRunner(req)
  if (denied) return denied
  try {
    const kindParam = req.nextUrl.searchParams.get('kind')
    if (kindParam && !isFileKind(kindParam)) return NextResponse.json({ error: 'kind phải là PRINT hoặc MOCKUP' }, { status: 400 })
    const guard = await agentUploadGuard(params.key, fileKindOf(kindParam))
    if ('error' in guard) return NextResponse.json({ error: guard.error }, { status: guard.status })
    const agent = await ensureAgentUser()
    const r = await receiveTaskArtwork(req, params.key, agent.id)
    if ('error' in r) return NextResponse.json({ error: r.error }, { status: r.status })
    return NextResponse.json({ ok: true, artworkId: r.artwork.id, version: r.artwork.version, printArea: r.artwork.printArea })
  } catch (e) {
    return agentErrorResponse(e)
  }
}
