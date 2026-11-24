import { createHash } from 'node:crypto'
import { prisma } from '@/lib/db'
import { assertSafeExternalUrl } from '@/lib/safe-url'

export type ToadditHttpResponse = { status: number; text: string }

async function reserveRequestSlot(appKey: string, origin: string): Promise<void> {
  const key = `toaddit.rate.${createHash('sha256').update(`${origin}:${appKey}`).digest('hex')}`
  const at = await prisma.$transaction(async tx => {
    const row = await tx.appSetting.findUnique({ where: { key } })
    const old = Number(row?.value)
    const now = Date.now()
    if (Number.isFinite(old) && old > now + 60_000) throw new Error('Hàng đợi Toaddit đang đầy — thử lại sau')
    const at = Math.max(now, Number.isFinite(old) ? old : now)
    const value = String(at + 1100)
    await tx.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } })
    return at
  })
  const delay = at - Date.now()
  if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
}

/** Toaddit requires HTTP/2. Native fetch on this application's Node version speaks HTTP/1.1. */
export async function postToadditHttp2(origin: string, path: string, headers: Record<string, string>, body: string): Promise<ToadditHttpResponse> {
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Toaddit endpoint không hợp lệ')
  const url = assertSafeExternalUrl(`${origin}${path}`, { allowedHosts: ['openapi.toaddit.com', 'openapi-sandbox.toaddit.com'] })
  if (url.origin !== origin || url.pathname !== path) throw new Error('Toaddit endpoint không hợp lệ')
  await reserveRequestSlot(headers['X-App-Key'], origin)
  const { connect } = await import('node:http2')
  return new Promise((resolve, reject) => {
    const client = connect(url.origin, { minVersion: 'TLSv1.2', ALPNProtocols: ['h2'] })
    let settled = false
    let stream: ReturnType<typeof client.request> | undefined
    const finish = (error: boolean, value?: ToadditHttpResponse) => {
      if (settled) return
      settled = true; clearTimeout(timer)
      stream?.close(); client.destroy()
      if (error) reject(new Error('Toaddit không phản hồi qua HTTP/2 hoặc kết nối bị ngắt'))
      else resolve(value!)
    }
    const timer = setTimeout(() => finish(true), 45_000)
    client.on('error', () => finish(true))
    client.on('close', () => { if (!settled) finish(true) })
    client.once('connect', () => {
      if (client.alpnProtocol !== 'h2') { finish(true); return }
      try {
        stream = client.request({ ':method': 'POST', ':path': path, 'content-type': 'application/json; charset=utf-8', accept: 'application/json', ...headers })
        let status = 0
        const chunks: Buffer[] = []
        let bytes = 0
        stream.on('response', h => { status = Number(h[':status']) })
        stream.on('data', chunk => {
          bytes += chunk.length
          if (bytes > 16 * 1024 * 1024) { finish(true); return }
          chunks.push(Buffer.from(chunk))
        })
        stream.on('error', () => finish(true))
        stream.on('end', () => finish(false, { status, text: Buffer.concat(chunks).toString('utf8') }))
        stream.end(body)
      } catch { finish(true) }
    })
  })
}
