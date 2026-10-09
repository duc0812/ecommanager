import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, unauthorized } from '@/lib/api-auth'
import { LibraryError, setArtworkSplit } from '@/lib/repos/artwork-library'

export async function PUT(req: NextRequest, { params }: { params: { key: string } }) {
  const user = await getAuthUser(req)
  if (!user) return unauthorized()
  const body = await req.json().catch(() => null)
  try {
    return NextResponse.json(await setArtworkSplit(params.key, body))
  } catch (err: any) {
    if (err instanceof LibraryError) return NextResponse.json({ error: err.message }, { status: err.status })
    throw err
  }
}
