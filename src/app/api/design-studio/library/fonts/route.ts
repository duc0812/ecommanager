import { NextResponse } from 'next/server'
import { listFonts } from '@/lib/repos/artwork-library'

export async function GET() {
  return NextResponse.json({ fonts: await listFonts() })
}
