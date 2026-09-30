import { prisma } from '@/lib/db'
import { dateOnly } from '@/lib/cashflow-dates'
import { buildAccountBalanceUpdate } from '@/lib/meta-balance'
import { cleanPaymentMethodLabel, parseLast4 } from '@/lib/meta-card'
import { summarizeBudgets, type BudgetEntity } from '@/lib/meta-reserve'

const GRAPH_API_VERSION = process.env.META_GRAPH_API_VERSION ?? 'v22.0'
const ACCOUNT_FIELDS = 'balance,currency,account_status,funding_source_details'
const BUDGET_FIELDS = 'id,effective_status,daily_budget,lifetime_budget,budget_remaining,stop_time'
const PAGE_LIMIT = 200
const MAX_PAGES = 20

export type MetaFetchJson = (url: string) => Promise<any>

export type ReserveAccountUpdate = {
  balance: number | null
  balanceCurrency: string | null
  balanceSyncedAt: Date
  accountStatus: number | null
  fundingCardLast4: string | null
  fundingCardLabel: string | null
  budgetRemaining: number
  plannedDailySpend: number
  spendToday: number
  activeCampaignCount: number
  budgetSyncedAt: Date
}

export function buildAccountMetaUpdate(json: Record<string, unknown>, currency: string | null, now: Date) {
  const details = json.funding_source_details
  const object = details && typeof details === 'object' ? details as Record<string, unknown> : {}
  const label = typeof object.display_string === 'string'
    ? object.display_string
    : typeof object.readable_card_type === 'string' ? object.readable_card_type : null
  return {
    ...buildAccountBalanceUpdate(json, currency, now),
    accountStatus: typeof json.account_status === 'number' ? json.account_status : null,
    fundingCardLast4: parseLast4(object),
    fundingCardLabel: cleanPaymentMethodLabel(label),
  }
}

function graphUrl(path: string, params: Record<string, string>) {
  const url = new URL(`https://graph.facebook.com/${GRAPH_API_VERSION}/${path}`)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  return url.toString()
}

async function fetchJsonFromGraph(url: string) {
  const response = await fetch(url)
  const json = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message = json?.error?.message ?? `HTTP ${response.status}`
    throw new Error(`Meta API: ${message}`)
  }
  return json
}

async function fetchAllPages(firstUrl: string, fetchJson: MetaFetchJson): Promise<BudgetEntity[]> {
  const rows: BudgetEntity[] = []
  let url: string | null = firstUrl
  let page = 0
  while (url && page < MAX_PAGES) {
    const json = await fetchJson(url)
    if (Array.isArray(json?.data)) rows.push(...json.data)
    url = typeof json?.paging?.next === 'string' ? json.paging.next : null
    page += 1
  }
  return rows
}

export async function fetchAccountReserve(
  account: { accountId: string; accessToken: string; currency: string | null },
  { today, now, fetchJson }: { today: string; now: Date; fetchJson: MetaFetchJson },
): Promise<{ update: ReserveAccountUpdate }> {
  const accessToken = account.accessToken
  const accountJson = await fetchJson(graphUrl(account.accountId, { fields: ACCOUNT_FIELDS, access_token: accessToken }))
  const currency = account.currency ?? (typeof accountJson?.currency === 'string' ? accountJson.currency : null)

  const campaigns = await fetchAllPages(graphUrl(`${account.accountId}/campaigns`, {
    fields: BUDGET_FIELDS,
    effective_status: '["ACTIVE"]',
    limit: String(PAGE_LIMIT),
    access_token: accessToken,
  }), fetchJson)

  // Only ABO campaigns (budget on the ad sets) need the extra call.
  const needsAdsets = campaigns.some(campaign =>
    campaign.effective_status === 'ACTIVE'
    && !Number(campaign.daily_budget ?? 0)
    && !Number(campaign.lifetime_budget ?? 0))
  const adsets = needsAdsets
    ? await fetchAllPages(graphUrl(`${account.accountId}/adsets`, {
      fields: `${BUDGET_FIELDS},campaign_id`,
      effective_status: '["ACTIVE"]',
      limit: String(PAGE_LIMIT),
      access_token: accessToken,
    }), fetchJson)
    : []

  const budgets = summarizeBudgets({ campaigns, adsets, currency: currency ?? 'USD', today })

  return {
    update: {
      ...buildAccountMetaUpdate(accountJson ?? {}, currency, now),
      budgetRemaining: budgets.budgetRemaining,
      plannedDailySpend: budgets.plannedDailySpend,
      spendToday: budgets.spendToday,
      activeCampaignCount: budgets.activeCampaignCount,
      budgetSyncedAt: now,
    },
  }
}

export type ReserveRefreshResult = {
  refreshed: string[]
  errors: { accountId: string; message: string }[]
}

export async function refreshReserveData(
  accountDbId?: string | null,
  { now = new Date(), fetchJson = fetchJsonFromGraph }: { now?: Date; fetchJson?: MetaFetchJson } = {},
): Promise<ReserveRefreshResult> {
  const accounts = await prisma.metaAdAccount.findMany({
    where: accountDbId ? { id: accountDbId } : {},
    select: { id: true, accountId: true, accessToken: true, currency: true },
    orderBy: { createdAt: 'asc' },
  })
  if (accountDbId && accounts.length === 0) throw new Error('Không tìm thấy ad account.')

  const today = dateOnly(now)
  const result: ReserveRefreshResult = { refreshed: [], errors: [] }

  for (const account of accounts) {
    try {
      const { update } = await fetchAccountReserve(account, { today, now, fetchJson })
      await prisma.metaAdAccount.update({ where: { id: account.id }, data: update })
      result.refreshed.push(account.accountId)
    } catch (error) {
      result.errors.push({
        accountId: account.accountId,
        message: error instanceof Error ? error.message : 'Lỗi không xác định',
      })
    }
  }

  return result
}
