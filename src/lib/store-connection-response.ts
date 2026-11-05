import { NextResponse } from 'next/server'
import type { StoreConnectionError } from '@/lib/store-connections'

// A store that is off or has no token keeps the route's existing "not connected" answer;
// a failed token refresh names the shop, since the cause is that shop's credentials.
export function connectionFailureResponse(error: StoreConnectionError, notConnected: { error: string; status: number }) {
  if (error.code === 'MINT_FAILED') return NextResponse.json({ error: error.message }, { status: 502 })
  return NextResponse.json({ error: notConnected.error }, { status: notConnected.status })
}
