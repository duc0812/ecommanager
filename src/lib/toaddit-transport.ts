import { createHash } from 'node:crypto'
import { prisma } from '@/lib/db'
import { assertSafeExternalUrl } from '@/lib/safe-url'
import { TOADDIT_ORIGIN } from '@/lib/toaddit-shared'

export type ToadditHttpResponse = { status: number; text: string }
async function reserveRequestSlot(apiKey: string): Promise<void> {
  const key = `toaddit.rosRate.${createHash('sha256').update(apiKey).digest('hex')}`
  const at = await prisma.$transaction(async tx => {
    const row = await tx.appSetting.findUnique({ where: { key } })
    const old = Number(row?.value), now = Date.now()
    if (Number.isFinite(old) && old > now + 60_000) throw new Error('Hàng đợi Toaddit đang đầy — thử lại sau')
    const at = Math.max(now, Number.isFinite(old) ? old : now), value = String(at + 1100)
    await tx.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } })
    return at
  })
  if (at > Date.now()) await new Promise(resolve => setTimeout(resolve, at - Date.now()))
}
export async function postToadditRos(apiKey: string, path: string, body: string): Promise<ToadditHttpResponse> {
  if (!/^\/api\/v1\/(order|prototype)\/[A-Za-z]+$/.test(path)) throw new Error('Toaddit endpoint không hợp lệ')
  const url = assertSafeExternalUrl(`${TOADDIT_ORIGIN}${path}`, { allowedHosts: ['ros-openapi.toaddit.com'] })
  if (url.origin !== TOADDIT_ORIGIN || url.pathname !== path || url.search) throw new Error('Toaddit endpoint không hợp lệ')
  await reserveRequestSlot(apiKey)
  const response = await fetch(url, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(45_000),
    headers: { 'content-type': 'application/json', accept: 'application/json', Authorization: `Bearer ${apiKey}` }, body,
  })
  const chunks: Uint8Array[] = []
  let bytes = 0
  if (!response.body) throw new Error('Toaddit không trả dữ liệu')
  const reader = response.body.getReader()
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      bytes += value.length
      if (bytes > 16 * 1024 * 1024) throw new Error('Dữ liệu Toaddit quá lớn')
      chunks.push(value)
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  return { status: response.status, text: Buffer.concat(chunks).toString('utf8') }
}
