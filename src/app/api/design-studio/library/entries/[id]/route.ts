import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, requireAdmin, unauthorized } from '@/lib/api-auth'
import { LibraryError, deleteEntry, loadEntryView, updateEntry } from '@/lib/repos/artwork-library'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const entry = await loadEntryView(params.id)
  if (!entry) return NextResponse.json({ error: 'Không tìm thấy entry' }, { status: 404 })
  return NextResponse.json({ entry })
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getAuthUser(req)
  if (!user) return unauthorized()
  const body = await req.json().catch(() => null)
  try {
    return NextResponse.json({ entry: await updateEntry(params.id, body, user) })
  } catch (err: any) {
    if (err instanceof LibraryError) return NextResponse.json({ error: err.message }, { status: err.status })
    throw err
  }
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAdmin(req)
  if ('error' in auth) return auth.error
  if (!(await deleteEntry(params.id))) return NextResponse.json({ error: 'Không tìm thấy entry' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
