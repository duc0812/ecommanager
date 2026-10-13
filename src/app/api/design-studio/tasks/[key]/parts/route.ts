import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser } from '@/lib/api-auth'
import { ArtworkRemoveError, renameArtworkPart } from '@/lib/design-storage'
import { enqueueFolderTidy } from '@/lib/drive-push-queue'
import { fileKindOf, isFileKind } from '@/lib/task-files'

/** Renames one part of a task: body `{ kind?, from, to }`. Every version of the part takes the new label. */
export async function PATCH(req: NextRequest, { params }: { params: { key: string } }) {
  const user = await getAuthUser(req)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await req.json().catch(() => null)
  if (!body || typeof body.from !== 'string' || typeof body.to !== 'string') {
    return NextResponse.json({ error: 'Cần from và to' }, { status: 400 })
  }
  if (body.kind != null && !isFileKind(body.kind)) return NextResponse.json({ error: 'kind phải là PRINT hoặc MOCKUP' }, { status: 400 })
  try {
    const renamed = await renameArtworkPart(params.key, { kind: fileKindOf(body.kind), from: body.from, to: body.to }, { id: user.id })
    if (renamed.changed > 0) enqueueFolderTidy(renamed.orderId, renamed.shopifyLineId)
    return NextResponse.json({ renamed: { kind: renamed.kind, from: renamed.from, to: renamed.to, changed: renamed.changed } })
  } catch (e: any) {
    if (e instanceof ArtworkRemoveError) return NextResponse.json({ error: e.message }, { status: e.status })
    return NextResponse.json({ error: e?.message ?? 'Lỗi không rõ' }, { status: 500 })
  }
}
