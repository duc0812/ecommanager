import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/db'
import { requireSuperadmin } from '@/lib/api-auth'
import { ONLY_SELLER_HAS_STORES, parseStoreIds, replaceStoreAccess } from '@/lib/user-store-access'
import { resolveSkuPrefixChange } from '@/lib/clone/sku-code'

export const dynamic = 'force-dynamic'

const MIN_PASSWORD_LENGTH = 10

// `password` sets a new password; `storeIds` replaces the stores of a seller; `skuPrefix` sets or clears (empty string) the SKU code letters. Any of them.
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireSuperadmin(req)
  if ('error' in auth) return auth.error
  const body = await req.json().catch(() => ({}))
  const wantsStores = body?.storeIds !== undefined
  const wantsSkuPrefix = body?.skuPrefix !== undefined
  const password = String(body?.password ?? '')
  const wantsPassword = (!wantsStores && !wantsSkuPrefix) || password !== ''
  if (wantsPassword && password.length < MIN_PASSWORD_LENGTH) {
    return NextResponse.json({ error: `Password phải có ít nhất ${MIN_PASSWORD_LENGTH} ký tự` }, { status: 400 })
  }
  const target = await prisma.appUser.findUnique({ where: { id: params.id }, select: { id: true, role: true } })
  if (!target) return NextResponse.json({ error: 'User not found' }, { status: 404 })
  if (wantsPassword && target.role === 'SUPERADMIN' && target.id !== auth.user.id) {
    return NextResponse.json({ error: 'Chỉ chính Super Admin mới đổi được password của mình' }, { status: 403 })
  }

  let storeIds: string[] | undefined
  if (wantsStores) {
    const parsed = await parseStoreIds(body.storeIds)
    if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })
    if (target.role !== 'SELLER' && parsed.ids.length > 0) return NextResponse.json({ error: ONLY_SELLER_HAS_STORES }, { status: 400 })
    storeIds = parsed.ids
  }

  const skuPrefix = await resolveSkuPrefixChange(body?.skuPrefix, params.id)
  if ('error' in skuPrefix) return NextResponse.json({ error: skuPrefix.error }, { status: skuPrefix.status })

  if (wantsPassword) {
    const passwordHash = await bcrypt.hash(password, 10)
    await prisma.appUser.update({
      where: { id: params.id },
      data: { passwordHash, tokenVersion: { increment: 1 } },
    })
  }
  if (skuPrefix.change) await prisma.appUser.update({ where: { id: params.id }, data: { skuPrefix: skuPrefix.value } })
  if (storeIds) await replaceStoreAccess(params.id, storeIds)
  return NextResponse.json({ ok: true, ...(storeIds ? { storeIds } : {}), ...(skuPrefix.change ? { skuPrefix: skuPrefix.value } : {}) })
}
