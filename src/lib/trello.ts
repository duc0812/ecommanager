export type TrelloConfig = {
  apiKey: string
  token: string
  listId: string
  doneListId: string
  syncFromOrderName: string
}

export type TrelloCard = {
  id: string
  name: string
  url: string
  attachments?: Array<{ url: string; name: string }>
}

const BASE = 'https://api.trello.com/1'

function auth(cfg: TrelloConfig) {
  return `key=${cfg.apiKey}&token=${cfg.token}`
}

export async function createTrelloCard(
  cfg: TrelloConfig,
  name: string,
  desc: string,
): Promise<TrelloCard> {
  const res = await fetch(
    `${BASE}/cards?${auth(cfg)}&idList=${cfg.listId}&name=${encodeURIComponent(name)}&desc=${encodeURIComponent(desc)}`,
    { method: 'POST' },
  )
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Trello createCard failed ${res.status}: ${text}`)
  }
  const data = await res.json()
  return { id: data.id, name: data.name, url: data.shortUrl ?? data.url }
}

export async function getCardsByList(cfg: TrelloConfig, listId: string): Promise<TrelloCard[]> {
  const res = await fetch(
    `${BASE}/lists/${listId}/cards?${auth(cfg)}&attachments=true&fields=id,name,shortUrl`,
  )
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Trello getCardsByList failed ${res.status}: ${text}`)
  }
  const data = await res.json()
  return data.map((c: any) => ({
    id: c.id,
    name: c.name,
    url: c.shortUrl ?? c.url,
    attachments: (c.attachments ?? []).map((a: any) => ({ url: a.url, name: a.name })),
  }))
}

export function shouldCreateCard(
  orderName: string,
  syncFromOrderName: string,
): boolean {
  const extractNum = (s: string) => parseInt(s.replace(/\D/g, ''), 10) || 0
  return extractNum(orderName) >= extractNum(syncFromOrderName)
}

export async function getTrelloConfig(): Promise<TrelloConfig | null> {
  const { prisma } = await import('@/lib/db')
  const rows = await prisma.appSetting.findMany({
    where: { key: { in: ['trello.apiKey', 'trello.token', 'trello.listId', 'trello.doneListId', 'trello.syncFromOrderName'] } },
  })
  const m = Object.fromEntries(rows.map(r => [r.key, r.value]))
  if (!m['trello.apiKey'] || !m['trello.token'] || !m['trello.listId'] || !m['trello.doneListId']) return null
  return {
    apiKey: m['trello.apiKey'],
    token: m['trello.token'],
    listId: m['trello.listId'],
    doneListId: m['trello.doneListId'],
    syncFromOrderName: m['trello.syncFromOrderName'] ?? 'LIT2341',
  }
}
