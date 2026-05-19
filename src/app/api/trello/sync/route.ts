import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getTrelloConfig, getCardsByList } from '@/lib/trello'

export async function POST() {
  const cfg = await getTrelloConfig()
  if (!cfg) {
    return NextResponse.json({ error: 'Trello chưa được cấu hình. Vào Setup để nhập API key.' }, { status: 400 })
  }

  let cards
  try {
    cards = await getCardsByList(cfg, cfg.doneListId)
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 502 })
  }

  let updated = 0

  for (const card of cards) {
    const driveAttachment = card.attachments?.find(a => a.url.includes('drive.google.com'))
    if (!driveAttachment) continue

    const result = await prisma.skuDesign.updateMany({
      where: { trelloCardId: card.id, designReady: false },
      data: { designReady: true, driveLink: driveAttachment.url },
    })
    updated += result.count
  }

  return NextResponse.json({ updated, cardsChecked: cards.length })
}
