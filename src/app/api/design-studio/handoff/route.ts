import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, unauthorized } from '@/lib/api-auth'
import { viewerFor } from '@/lib/design-tasks'
import { getDesignSettings } from '@/lib/design-settings'
import { countPendingHandoff, listHandoffCards } from '@/lib/supplier-handoff'

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!user) return unauthorized()
  const q = req.nextUrl.searchParams.get('q')?.trim() || undefined
  const [cards, pendingCount, settings] = await Promise.all([listHandoffCards({ q }), countPendingHandoff(), getDesignSettings()])
  return NextResponse.json({ ...cards, pendingCount, me: viewerFor(user, settings) })
}
