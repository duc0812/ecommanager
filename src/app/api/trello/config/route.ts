import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

const TRELLO_KEYS = [
  'trello.apiKey',
  'trello.token',
  'trello.listId',
  'trello.doneListId',
  'trello.syncFromOrderName',
]

export async function GET() {
  const rows = await prisma.appSetting.findMany({ where: { key: { in: TRELLO_KEYS } } })
  const config = Object.fromEntries(rows.map(r => [r.key.replace('trello.', ''), r.value]))
  return NextResponse.json(config)
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const updates: Array<{ key: string; value: string }> = []
  for (const field of ['apiKey', 'token', 'listId', 'doneListId', 'syncFromOrderName']) {
    if (body[field] !== undefined) {
      updates.push({ key: `trello.${field}`, value: String(body[field]) })
    }
  }
  await Promise.all(
    updates.map(u =>
      prisma.appSetting.upsert({
        where: { key: u.key },
        create: { key: u.key, value: u.value },
        update: { value: u.value },
      }),
    ),
  )
  return NextResponse.json({ ok: true })
}
