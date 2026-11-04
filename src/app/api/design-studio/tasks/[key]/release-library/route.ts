import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, unauthorized } from '@/lib/api-auth'
import { releaseLibraryTask } from '@/lib/design-tasks'

export async function POST(req: NextRequest, { params }: { params: { key: string } }) {
  const user = await getAuthUser(req)
  if (!user) return unauthorized()
  try {
    return NextResponse.json(await releaseLibraryTask(params.key, { id: user.id, name: user.name, role: user.role, permissions: user.permissions }))
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: /not found/i.test(e.message) ? 404 : 400 })
  }
}
