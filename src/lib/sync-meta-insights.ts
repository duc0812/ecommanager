import { prisma } from '@/lib/db'
import { isMetaBillingSyncWorkerActive } from '@/lib/meta-billing-sync'

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

export type SyncMetaInsightsOptions = {
  days?: number
  since?: string | null   // "YYYY-MM-DD" — backfill from this date instead of the rolling window
  until?: string | null   // "YYYY-MM-DD" — defaults to today
  accountId?: string | null  // limit the sync to a single MetaAdAccount.id
  fromProjectStart?: boolean // backfill each account from its linked project's start date
}

function validDateKey(value: string | null | undefined) {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null
}

export async function syncMetaInsights(
  optionsOrDays: number | SyncMetaInsightsOptions = {}
): Promise<{ synced: number; accounts: number; errors: string[]; perAccount: Array<{ name: string; rows: number }>; range: { since: string; until: string } }> {
  const options: SyncMetaInsightsOptions = typeof optionsOrDays === 'number' ? { days: optionsOrDays } : optionsOrDays

  const emptyRange = { since: '', until: '' }
  if (isMetaBillingSyncWorkerActive()) {
    return {
      synced: 0,
      accounts: 0,
      errors: ['Meta billing đang chạy nền; Insights được bỏ qua để tránh gọi API đồng thời.'],
      perAccount: [],
      range: emptyRange,
    }
  }

  const accountId = options.accountId?.trim() || null
  const accounts = await prisma.metaAdAccount.findMany({
    ...(accountId ? { where: { id: accountId } } : {}),
    include: { project: { select: { startDate: true } } },
  })
  if (accounts.length === 0) return { synced: 0, accounts: 0, errors: ['No Meta accounts configured'], perAccount: [], range: emptyRange }

  // Sync-window strategy:
  //   1. explicit since/until → manual backfill of an exact range (same for all accounts)
  //   2. explicit days        → fixed rolling last-N-days window (nightly finalization / back-compat)
  //   3. neither (default)    → smart per-account incremental:
  //        first sync  = from firstSyncSince (reaches back to capture the account's first spend day)
  //        next syncs  = from the last stored day → today (only the missing tail; also re-finalizes the last day)
  const explicitSince = validDateKey(options.since)
  const fromProjectStart = options.fromProjectStart === true
  const fixedDays = (typeof optionsOrDays === 'number' || options.days != null) ? (options.days ?? 30) : null
  const until = validDateKey(options.until) ?? dateOnly(new Date())
  // Meta only returns days that had delivery, so a wide first-sync range is cheap.
  const firstSyncSince = validDateKey(process.env.META_INSIGHTS_FIRST_SYNC_SINCE) ?? daysAgo(730)

  let totalSynced = 0
  const errors: string[] = []
  const perAccount: Array<{ name: string; rows: number }> = []
  let earliestSince = until

  for (const account of accounts) {
    let since: string
    if (explicitSince) {
      since = explicitSince
    } else if (fromProjectStart) {
      // Anchor to the project's start date; if it is missing or misconfigured
      // (later than today), fall back to the wide default so the backfill still works.
      const projectStart = account.project?.startDate ? dateOnly(account.project.startDate) : null
      since = projectStart && projectStart <= until ? projectStart : firstSyncSince
    } else if (fixedDays != null) {
      since = daysAgo(fixedDays)
    } else {
      const lastStored = await prisma.dailyAdSpend.findFirst({
        where: { adAccountId: account.id },
        orderBy: { date: 'desc' },
        select: { date: true },
      })
      since = lastStored?.date ?? firstSyncSince
    }
    if (since > until) since = until
    if (since < earliestSince) earliestSince = since

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

  return { synced: totalSynced, accounts: accounts.length, errors, perAccount, range: { since: earliestSince, until } }
}
