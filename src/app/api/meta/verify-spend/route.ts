import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

const GRAPH_API_VERSION = process.env.META_GRAPH_API_VERSION ?? 'v19.0'

function dateOnly(d: Date) {
  return d.toISOString().split('T')[0]
}

function safeFloat(s: string | null | undefined): number {
  const n = parseFloat(s ?? '0')
  return isNaN(n) ? 0 : n
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const accountId = searchParams.get('accountId')
  const days = Math.min(parseInt(searchParams.get('days') ?? '30', 10), 90)
  const since = searchParams.get('since')
  const until = searchParams.get('until')

  const accounts = accountId
    ? await prisma.metaAdAccount.findMany({ where: { id: accountId } })
    : await prisma.metaAdAccount.findMany()

  if (accounts.length === 0) {
    return NextResponse.json({ error: 'No accounts found' }, { status: 404 })
  }

  const sinceDate = since ?? dateOnly(new Date(Date.now() - days * 24 * 60 * 60 * 1000))
  const untilDate = until ?? dateOnly(new Date())

  const results = []

  for (const account of accounts) {
    const url = new URL(`https://graph.facebook.com/${GRAPH_API_VERSION}/${account.accountId}/insights`)
    url.searchParams.set('fields', 'spend,impressions,clicks,date_start,date_stop')
    url.searchParams.set('time_increment', '1')
    url.searchParams.set('time_range', JSON.stringify({ since: sinceDate, until: untilDate }))
    url.searchParams.set('level', 'account')

    let apiRows: Array<{ date: string; spend: number; impressions: number; clicks: number }> = []
    let apiError: string | null = null

    try {
      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${account.accessToken}` },
      })
      const json = await res.json()

      if (json.error) {
        apiError = json.error?.message ?? String(json.error)
      } else {
        const raw: Array<{ spend: string; impressions: string; clicks: string; date_start: string }> = json.data ?? []
        apiRows = raw.map(r => ({
          date: r.date_start,
          spend: safeFloat(r.spend),
          impressions: parseInt(r.impressions ?? '0', 10),
          clicks: parseInt(r.clicks ?? '0', 10),
        }))
      }
    } catch (err: any) {
      apiError = err?.message ?? 'Fetch failed'
    }

    const dbRows = await prisma.dailyAdSpend.findMany({
      where: { adAccountId: account.id, date: { gte: sinceDate, lte: untilDate } },
      orderBy: { date: 'asc' },
    })
    const dbByDate = new Map(dbRows.map(r => [r.date, r]))

    const apiByDate = new Map(apiRows.map(r => [r.date, r]))

    const allDates = new Set([...Array.from(apiByDate.keys()), ...Array.from(dbByDate.keys())])
    const comparison = Array.from(allDates).sort().map(date => {
      const api = apiByDate.get(date)
      const db = dbByDate.get(date)
      const diff = Math.round(((api?.spend ?? 0) - (db?.spend ?? 0)) * 100) / 100
      return {
        date,
        api_spend: api?.spend ?? null,
        db_spend: db ? db.spend : null,
        diff,
        match: Math.abs(diff) < 0.01,
      }
    })

    const totalApiSpend = Math.round(apiRows.reduce((s, r) => s + r.spend, 0) * 100) / 100
    const totalDbSpend = Math.round(dbRows.reduce((s, r) => s + r.spend, 0) * 100) / 100
    const mismatchDates = comparison.filter(r => !r.match && (r.api_spend !== null || r.db_spend !== null))

    results.push({
      accountId: account.id,
      accountName: account.accountName,
      metaAccountId: account.accountId,
      currency: account.currency,
      range: { since: sinceDate, until: untilDate },
      apiError,
      summary: {
        totalApiSpend,
        totalDbSpend,
        totalDiff: Math.round((totalApiSpend - totalDbSpend) * 100) / 100,
        apiDays: apiRows.length,
        dbDays: dbRows.length,
        mismatchCount: mismatchDates.length,
      },
      mismatches: mismatchDates,
      all: comparison,
    })
  }

  return NextResponse.json({ results, range: { since: sinceDate, until: untilDate } })
}
