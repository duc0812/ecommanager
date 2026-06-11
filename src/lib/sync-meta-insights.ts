import { prisma } from '@/lib/db'

const GRAPH_API_VERSION = process.env.META_GRAPH_API_VERSION ?? 'v22.0'

function dateOnly(d: Date) {
  return d.toISOString().split('T')[0]
}

function daysAgo(n: number) {
  return dateOnly(new Date(Date.now() - n * 24 * 60 * 60 * 1000))
}

function safeFloat(s: string | null | undefined): number {
  const n = parseFloat(s ?? '0')
  return isNaN(n) ? 0 : n
}

function safeInt(s: string | null | undefined): number {
  const n = parseInt(s ?? '0', 10)
  return isNaN(n) ? 0 : n
}

export async function syncMetaInsights(
  days = 30
): Promise<{ synced: number; accounts: number; errors: string[]; perAccount: Array<{ name: string; rows: number }> }> {
  const accounts = await prisma.metaAdAccount.findMany()
  if (accounts.length === 0) return { synced: 0, accounts: 0, errors: ['No Meta accounts configured'], perAccount: [] }

  const since = daysAgo(days)
  const until = dateOnly(new Date())
  let totalSynced = 0
  const errors: string[] = []
  const perAccount: Array<{ name: string; rows: number }> = []

  for (const account of accounts) {
    const url = new URL(`https://graph.facebook.com/${GRAPH_API_VERSION}/${account.accountId}/insights`)
    url.searchParams.set('fields', 'spend,impressions,clicks')
    url.searchParams.set('time_increment', '1')
    url.searchParams.set('time_range', JSON.stringify({ since, until }))
    url.searchParams.set('level', 'account')
    url.searchParams.set('limit', '500')

    // Insights API pages its results (default 25 rows) — follow paging.next or recent days get dropped
    const rows: Array<{ spend: string; impressions: string; clicks: string; date_start: string }> = []
    let nextUrl: string | null = url.toString()
    let failed = false
    while (nextUrl) {
      try {
        const res: Response = await fetch(nextUrl, {
          headers: { Authorization: `Bearer ${account.accessToken}` },
        })
        const json: any = await res.json()
        if (!res.ok || json.error) {
          const errMsg = json.error?.message ?? json.error ?? `HTTP ${res.status}`
          errors.push(`${account.accountName ?? account.accountId}: ${errMsg}`)
          failed = rows.length === 0
          break
        }
        rows.push(...(json.data ?? []))
        nextUrl = json.paging?.next ?? null
      } catch (e: any) {
        errors.push(`${account.accountName ?? account.accountId}: ${e?.message ?? 'Network error'}`)
        failed = rows.length === 0
        break
      }
    }
    if (failed) {
      perAccount.push({ name: account.accountName ?? account.accountId, rows: 0 })
      continue
    }

    for (const row of rows) {
      const spend = safeFloat(row.spend)
      const impressions = safeInt(row.impressions)
      const clicks = safeInt(row.clicks)
      const currency = account.currency ?? 'USD'

      await prisma.dailyAdSpend.upsert({
        where: { adAccountId_date: { adAccountId: account.id, date: row.date_start } },
        create: { adAccountId: account.id, date: row.date_start, spend, impressions, clicks, currency, fetchedAt: new Date() },
        update: { spend, impressions, clicks, fetchedAt: new Date() },
      })
      totalSynced++
    }

    perAccount.push({ name: account.accountName ?? account.accountId, rows: rows.length })

    await prisma.metaAdAccount.update({
      where: { id: account.id },
      data: { lastSyncAt: new Date() },
    })
  }

  return { synced: totalSynced, accounts: accounts.length, errors, perAccount }
}
