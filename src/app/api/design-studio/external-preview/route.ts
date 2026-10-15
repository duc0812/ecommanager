import { NextRequest, NextResponse } from 'next/server'
import { describeDesignLinks } from '@/lib/drive-public'

export async function GET(req: NextRequest) {
  const link = req.nextUrl.searchParams.get('url') ?? ''
  if (!link || link.length > 4000) return NextResponse.json({ error: 'Thiếu link' }, { status: 400 })
  const links = await describeDesignLinks(link)
  return NextResponse.json({ links }, { headers: { 'Cache-Control': 'private, max-age=300' } })
}
