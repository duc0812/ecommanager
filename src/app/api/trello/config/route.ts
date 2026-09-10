import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireSuperadmin } from '@/lib/api-auth'

export const dynamic = 'force-dynamic'

const SECRET_FIELDS = ['apiKey', 'token'] as const
const PLAIN_FIELDS = ['boardId', 'listId', 'doneListId', 'syncFromOrderName'] as const
const ALL_FIELDS = [...SECRET_FIELDS, ...PLAIN_FIELDS]
const TRELLO_KEYS = ALL_FIELDS.map(f => `trello.${f}`)

function mask(value: string | undefined) {
  if (!value) return ''
  return value.length <= 8 ? '••••' : `${value.slice(0, 4)}…${value.slice(-4)}`
}

export async function GET() {
  const rows = await prisma.appSetting.findMany({ where: { key: { in: TRELLO_KEYS } } })
  const values = Object.fromEntries(rows.map(r => [r.key.replace('trello.', ''), r.value]))
  const config: Record<string, string | boolean> = {}
  for (const field of PLAIN_FIELDS) config[field] = values[field] ?? ''
  for (const field of SECRET_FIELDS) {
    config[`has${field[0].toUpperCase()}${field.slice(1)}`] = Boolean(values[field])
    config[`${field}Masked`] = mask(values[field])
  }
  return NextResponse.json(config)
}

export async function POST(req: NextRequest) {
  const auth = await requireSuperadmin(req)
  if ('error' in auth) return auth.error
  const body = await req.json().catch(() => ({}))
  const updates: Array<{ key: string; value: string }> = []
  for (const field of ALL_FIELDS) {
    if (body[field] === undefined) continue
    const value = String(body[field]).trim()
    if (SECRET_FIELDS.includes(field as any) && !value) continue
    updates.push({ key: `trello.${field}`, value })
  }
  for (const u of updates) {
    await prisma.appSetting.upsert({ where: { key: u.key }, create: u, update: { value: u.value } })
  }
  return NextResponse.json({ ok: true, updated: updates.map(u => u.key.replace('trello.', '')) })
}
