import { NextRequest, NextResponse } from 'next/server'
import { getSheets, saveSheets, getMinAgeDays, setMinAgeDays, parseSheetsJson } from '@/lib/fulfillment/auto-fulfill-sheets'

export async function GET() {
  const [sheets, minAgeDays] = await Promise.all([getSheets(), getMinAgeDays()])
  return NextResponse.json({ sheets, minAgeDays })
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Body không hợp lệ.' }, { status: 400 })
  if (Array.isArray(body.sheets)) await saveSheets(parseSheetsJson(JSON.stringify(body.sheets)))
  if (body.minAgeDays !== undefined) await setMinAgeDays(Number(body.minAgeDays))
  const [sheets, minAgeDays] = await Promise.all([getSheets(), getMinAgeDays()])
  return NextResponse.json({ sheets, minAgeDays })
}
