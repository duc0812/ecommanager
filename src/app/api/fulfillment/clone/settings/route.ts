import { NextRequest, NextResponse } from 'next/server'
import { requireSuperadmin } from '@/lib/api-auth'
import { getCloneSettings, saveCloneSettings } from '@/lib/clone/settings'
import { cloneWorkerInfo, generateCloneWorkerToken, revokeCloneWorkerToken } from '@/lib/clone/worker'
import { badRequest, cloneErrorResponse, isJsonObject, readJson } from '@/lib/clone/route-http'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const auth = await requireSuperadmin(req)
  if ('error' in auth) return auth.error
  const [settings, worker] = await Promise.all([getCloneSettings(), cloneWorkerInfo()])
  return NextResponse.json({ ...settings, worker })
}

// The mint answer is the only response anywhere in the feature that carries a worker token.
export async function POST(req: NextRequest) {
  const auth = await requireSuperadmin(req)
  if ('error' in auth) return auth.error
  const body = await readJson(req)
  try {
    if (isJsonObject(body) && body.action !== undefined) {
      if (body.action === 'mint-token') return NextResponse.json({ token: await generateCloneWorkerToken() })
      if (body.action === 'revoke-token') {
        await revokeCloneWorkerToken()
        return NextResponse.json({ ok: true })
      }
      return badRequest()
    }
    return NextResponse.json(await saveCloneSettings(body))
  } catch (e) {
    return cloneErrorResponse(e)
  }
}
