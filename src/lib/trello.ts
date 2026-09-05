export type TrelloConfig = {
  apiKey: string
  token: string
  boardId: string
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
  const res = await fetch(`${BASE}/cards?${auth(cfg)}&idList=${cfg.listId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, desc }),
  })
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

// Bulk card edits run hundreds of calls in a row and Trello caps a token at 100 req/10s,
// so back off and retry instead of failing the whole batch on a 429.
async function fetchWithRateLimitRetry(url: string, init?: RequestInit, attempts = 3): Promise<Response> {
  let res = await fetch(url, init)
  for (let i = 1; i < attempts && res.status === 429; i += 1) {
    const retryAfter = parseFloat(res.headers.get('retry-after') ?? '') || i
    await new Promise(r => setTimeout(r, Math.min(retryAfter, 10) * 1000))
    res = await fetch(url, init)
  }
  return res
}

export async function getCardDesc(cfg: TrelloConfig, cardId: string): Promise<string | null> {
  const res = await fetchWithRateLimitRetry(`${BASE}/cards/${cardId}?${auth(cfg)}&fields=id,desc`)
  // A card deleted on the board leaves a stale trelloCardId behind — treat it as "nothing to update".
  if (res.status === 404) return null
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Trello getCard failed ${res.status}: ${text}`)
  }
  const data = await res.json()
  return data.desc ?? ''
}

export async function updateCardDesc(cfg: TrelloConfig, cardId: string, desc: string): Promise<void> {
  const res = await fetchWithRateLimitRetry(`${BASE}/cards/${cardId}?${auth(cfg)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ desc }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Trello updateCard failed ${res.status}: ${text}`)
  }
}

export function shouldCreateCard(
  orderName: string,
  syncFromOrderName: string,
): boolean {
  const extractNum = (s: string) => parseInt(s.replace(/\D/g, ''), 10) || 0
  return extractNum(orderName) >= extractNum(syncFromOrderName)
}

export async function addAttachmentToCard(
  cfg: TrelloConfig,
  cardId: string,
  url: string,
  name: string,
): Promise<void> {
  const res = await fetch(`${BASE}/cards/${cardId}/attachments?${auth(cfg)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, name }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Trello addAttachment failed ${res.status}: ${text}`)
  }
}

export async function getTrelloConfig(): Promise<TrelloConfig | null> {
  const { prisma } = await import('@/lib/db')
  const rows = await prisma.appSetting.findMany({
    where: { key: { in: ['trello.apiKey', 'trello.token', 'trello.boardId', 'trello.listId', 'trello.doneListId', 'trello.syncFromOrderName'] } },
  })
  const m = Object.fromEntries(rows.map(r => [r.key, r.value]))
  if (!m['trello.apiKey'] || !m['trello.token'] || !m['trello.boardId'] || !m['trello.listId'] || !m['trello.doneListId']) return null
  return {
    apiKey: m['trello.apiKey'],
    token: m['trello.token'],
    boardId: m['trello.boardId'],
    listId: m['trello.listId'],
    doneListId: m['trello.doneListId'],
    syncFromOrderName: m['trello.syncFromOrderName'] ?? '',
  }
}
