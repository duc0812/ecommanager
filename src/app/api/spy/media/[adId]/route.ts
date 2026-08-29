import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { readCached } from '@/lib/spy/media-cache'

export const dynamic = 'force-dynamic'

export async function GET(_req: NextRequest, { params }: { params: { adId: string } }) {
  const cached = readCached(params.adId)
  if (cached) {
    return new NextResponse(cached.buffer as unknown as BodyInit, {
      headers: {
        'Content-Type': cached.contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    })
  }
  // Not cached yet — fall back to the original (may still be alive; may be expired).
  const ad = await prisma.spyAd.findUnique({ where: { id: params.adId }, select: { mediaUrl: true } })
  if (ad?.mediaUrl) return NextResponse.redirect(ad.mediaUrl)
  return new NextResponse(null, { status: 404 })
}
