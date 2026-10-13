import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser } from '@/lib/api-auth'
import { ArtworkRemoveError, removeArtwork } from '@/lib/design-storage'
import { enqueueFolderTidy } from '@/lib/drive-push-queue'

export async function DELETE(req: NextRequest, { params }: { params: { artworkId: string } }) {
  const user = await getAuthUser(req)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const { orderId, shopifyLineId, ...removed } = await removeArtwork(params.artworkId, { id: user.id, role: user.role })
    // The Drive copy leaves the task folder for `_old`; the version before it becomes the current file again.
    enqueueFolderTidy(orderId, shopifyLineId)
    return NextResponse.json({ removed })
  } catch (e: any) {
    if (e instanceof ArtworkRemoveError) return NextResponse.json({ error: e.message }, { status: e.status })
    return NextResponse.json({ error: e?.message ?? 'Lỗi không rõ' }, { status: 500 })
  }
}
