import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs/promises'
import path from 'path'
import { prisma } from '@/lib/db'
import { visibleOutsource, OutsourceError } from '@/lib/design-outsource'
import { outsourceRoute } from '@/lib/design-outsource-route'
import { GUIDE_SIZE, GUIDE_SIZE_TOKEN } from '@/lib/print-template-resolve'
import { localArtworkPath } from '@/lib/design-storage'
import { assertSafeExternalUrl } from '@/lib/safe-url'

export const dynamic = 'force-dynamic'
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
const MAX_IMAGE = 20 * 1024 * 1024

async function referenceImage(source: string) {
  let url = source
  for (let hop = 0; hop < 4; hop++) {
    assertSafeExternalUrl(url)
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(20_000), headers: { Accept: 'image/*' }, cache: 'no-store' })
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const target = res.headers.get('location')
      await res.body?.cancel()
      if (!target) break
      url = new URL(target, url).href
      continue
    }
    const mime = res.headers.get('content-type')?.split(';')[0] ?? ''
    if (!res.ok || !IMAGE_TYPES.includes(mime) || Number(res.headers.get('content-length')) > MAX_IMAGE) { await res.body?.cancel(); break }
    const reader = res.body?.getReader()
    if (!reader) break
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.length
        if (size > MAX_IMAGE) { await reader.cancel(); throw new OutsourceError('Ảnh tham chiếu quá lớn', 413) }
        chunks.push(chunk.value)
      }
    } finally { reader.releaseLock() }
    return { bytes: Buffer.concat(chunks), mime }
  }
  throw new OutsourceError('Ảnh tham chiếu chưa tải được, liên hệ nội bộ', 502)
}

export function GET(req: NextRequest, { params }: { params: { code: string } }) {
  return outsourceRoute(req, async user => {
    const a = await visibleOutsource(params.code, user)
    if (req.nextUrl.searchParams.has('r') && Number(req.nextUrl.searchParams.get('r')) !== a.revision) throw new OutsourceError('Không tìm thấy ảnh', 404)
    const kind = req.nextUrl.searchParams.get('kind')
    let image: { bytes: Buffer; mime: string }
    if (kind === 'reference' && a.referenceUrl) image = await referenceImage(a.referenceUrl)
    else if (kind === 'guide') {
      const t = await prisma.printTemplate.findUnique({ where: { id: JSON.parse(a.templateSnapshot).id }, select: { guideImagePath: true } })
      const guide = JSON.parse(a.templateSnapshot).guideImageUrl
      const size = guide ? new URL(guide, 'http://localhost').searchParams.get('size') ?? '' : ''
      const local = localArtworkPath(t?.guideImagePath?.replace(GUIDE_SIZE_TOKEN, GUIDE_SIZE.test(size) ? size : 'ALL') ?? null)
      const ext = local ? path.extname(local).toLowerCase() : ''
      if (!local || !['.png', '.jpg', '.jpeg'].includes(ext)) throw new OutsourceError('Không tìm thấy artguide', 404)
      const bytes = await fs.readFile(local).catch(() => null)
      if (!bytes) throw new OutsourceError('Không tìm thấy artguide', 404)
      image = { bytes, mime: ext === '.png' ? 'image/png' : 'image/jpeg' }
    } else throw new OutsourceError('Không tìm thấy ảnh', 404)
    return new NextResponse(image.bytes as unknown as BodyInit, { headers: { 'Content-Type': image.mime, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' } })
  })
}
