import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, type AuthUser } from '@/lib/api-auth'
import { OutsourceError } from '@/lib/design-outsource'
import { canManageOutsource } from '@/lib/roles'
import { OutsourceOperationError } from '@/lib/design-outsource-lock'

export async function outsourceRoute(req: NextRequest, run: (user: AuthUser) => Promise<NextResponse>) {
  try {
    const user = await getAuthUser(req)
    if (!user) return NextResponse.json({ error: 'Phiên đăng nhập đã hết hạn' }, { status: 401 })
    if (!canManageOutsource(user) && !(user.role === 'OUTSOURCE' && user.permissions.includes('design_outsource'))) throw new OutsourceError('Bạn không có quyền Design Outsource', 403)
    const response = await run(user)
    response.headers.set('Cache-Control', 'private, no-store')
    return response
  } catch (error) {
    if (error instanceof OutsourceError || error instanceof OutsourceOperationError) return NextResponse.json({ error: error.message }, { status: error.status, headers: { 'Cache-Control': 'no-store' } })
    console.error('[design outsource] request failed', error instanceof Error ? error.name : 'unknown')
    return NextResponse.json({ error: 'Chưa xử lý được yêu cầu. Vui lòng thử lại.' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}
