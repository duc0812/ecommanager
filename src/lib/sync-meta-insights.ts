import { prisma } from '@/lib/db'

const GRAPH_API_VERSION = process.env.META_GRAPH_API_VERSION ?? 'v19.0'

function dateOnly(d: Date) {
  return d.toISOString().split('T')[0]
}

function daysAgo(n: number) {
  return dateOnly(new Date(Date.now() - n * 24 * 60 * 60 * 1000))
}

export async function syncMetaInsights(
  days = 30
): Promise<{ synced: number; accounts: number; error?: string }> {
  const accounts = await prisma.metaAdAccount.findMany()
  if (accounts.length === 0) return { synced: 0, accounts: 0, error: 'No Meta accounts configured' }

  const since = daysAgo(days)
  const until = dateOnly(new Date())
  let totalSynced = 0

  for (const account of accounts) {
    const url = new URL(`https://graph.facebook.com/${GRAPH_API_VERSION}/${account.accountId}/insights`)
    url.searchParams.set('fields', 'spend,impressions,clicks')
    url.searchParams.set('time_increment', '1')
    url.searchParams.set('time_range', JSON.stringify({ since, until }))
    url.searchParams.set('level', 'account')
    url.searchParams.set('access_token', account.accessToken)

    const res = await fetch(url.toString())
    const json = await res.json()

    if (json.error) {
      console.error(`[sync-meta-insights] Account ${account.accountId}: ${json.error.message}`)
      continue
    }

    const rows: Array<{ spend: string; impressions: string; clicks: string; date_start: string }> =
      json.data ?? []

    for (const row of rows) {
      await prisma.dailyAdSpend.upsert({
        where: { adAccountId_date: { adAccountId: account.id, date: row.date_start } },
        create: {
          adAccountId: account.id,
          date: row.date_start,
          spend: parseFloat(row.spend ?? '0'),
          impressions: parseInt(row.impressions ?? '0', 10),
          clicks: parseInt(row.clicks ?? '0', 10),
          currency: account.currency ?? 'USD',
        },
        update: {
          spend: parseFloat(row.spend ?? '0'),
          impressions: parseInt(row.impressions ?? '0', 10),
          clicks: parseInt(row.clicks ?? '0', 10),
          fetchedAt: new Date(),
        },
      })
      totalSynced++
    }

    await prisma.metaAdAccount.update({
      where: { id: account.id },
      data: { lastSyncAt: new Date() },
    })
  }

  return { synced: totalSynced, accounts: accounts.length }
}
