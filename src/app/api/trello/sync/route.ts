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

    const skuDesign = await prisma.skuDesign.findFirst({ where: { trelloCardId: card.id } })
    if (skuDesign && !skuDesign.designReady) {
      await prisma.skuDesign.update({
        where: { id: skuDesign.id },
        data: { designReady: true, driveLink: driveAttachment.url },
      })
      updated++
    }
  }

  return NextResponse.json({ updated, cardsChecked: cards.length })
}
