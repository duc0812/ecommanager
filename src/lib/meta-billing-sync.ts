import { randomUUID } from 'node:crypto'
import { prisma } from '@/lib/db'
import type { MetaBillingSyncAccountProgress, MetaBillingSyncJob } from '@/lib/meta-billing-sync-types'
import { isMetaBillingSyncActive } from '@/lib/meta-billing-sync-types'
import { metaBillingDateInTimezone, normalizeMetaActivityAmount } from '@/lib/meta-billing-normalization'
import { isMetaRateLimitError, metaPageDelayMs, parseMetaUsagePercent } from '@/lib/meta-rate-limit'
import { buildAccountBalanceUpdate } from '@/lib/meta-balance'

const GRAPH_API_VERSION = process.env.META_GRAPH_API_VERSION ?? 'v22.0'
const DEFAULT_BACKFILL_DAYS = 90
const RESYNC_OVERLAP_DAYS = 3
const ACTIVITY_RANGE_DAYS = 1
const MIN_ACTIVITY_RANGE_MS = 1_000
const JOB_SETTING_KEY = 'meta.billingSyncJob'
const COVERAGE_SETTING_PREFIX = 'meta.billingCoverage.'
const VND_AMOUNT_NORMALIZATION_KEY = 'meta.billingAmountNormalization.v2'
const MAX_RATE_LIMIT_RETRIES = 5
const ACTIVITY_PAGE_LIMITS = [500, 200, 50, 25, 10, 5, 1] as const

type MetaAccount = {
  id: string
  accountId: string
  accountName: string | null
  accessToken: string
  currency: string | null
}

type MetaPaymentMethod = {
  label: string | null
  last4: string | null
  timezoneName: string | null
  balance: number | null
  balanceCurrency: string | null
  balanceSyncedAt: Date
}

type MetaTransaction = {
  id: string
  legacyId?: string | null
  amount: number
  currency: string
  billingDate: string
  status: string
  chargeType: string | null
  productType: string | null
  paymentMethod: string | null
  paymentMethodLast4: string | null
  referenceNumber: string | null
  receiptUrl: string | null
}

type GraphError = {
  code?: number
  message?: string
}

class MetaGraphError extends Error {
  constructor(message: string, readonly code: number | undefined, readonly status: number) {
    super(message)
    this.name = 'MetaGraphError'
  }
}

type MetaBillingRuntime = {
  worker: Promise<void> | null
  starting: Promise<StartMetaBillingSyncResult> | null
}

type StartMetaBillingSyncResult = {
  job: MetaBillingSyncJob
  alreadyRunning: boolean
}

const globalForMetaBilling = globalThis as typeof globalThis & {
  metaBillingSyncRuntime?: MetaBillingRuntime
}

const syncRuntime = globalForMetaBilling.metaBillingSyncRuntime ?? {
  worker: null,
  starting: null,
}

globalForMetaBilling.metaBillingSyncRuntime = syncRuntime

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function graphUrl(path: string, params: Record<string, string>) {
  const url = new URL(`https://graph.facebook.com/${GRAPH_API_VERSION}/${path}`)
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value))
  return url.toString()
}

function parseLast4(value: unknown): string | null {
  if (value == null) return null
  if (typeof value === 'object') {
    const details = value as Record<string, unknown>
    const direct = details.last4 ?? details.last_4 ?? details.card_last_four_digits
    if (direct) return String(direct).slice(-4)
  }

  const text = typeof value === 'string' ? value : JSON.stringify(value)
  const match = text.match(/(?:\*+|x+|\.{2,}|[-\s])(\d{4})(?!\d)/i)
  return match?.[1] ?? null
}

function cleanPaymentMethodLabel(value: string | null) {
  if (!value) return null
  return value.replace(/\s*(?:\*+|x+|\.{2,}|[-\s])\d{4}\s*$/i, '').trim() || value
}

function parseJsonMaybe(value: unknown) {
  if (!value || typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function asText(value: unknown): string | null {
  if (value == null) return null
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>
    if (typeof object.__html === 'string') return object.__html.replace(/<[^>]*>/g, '').trim()
    if (typeof object.display_string === 'string') return object.display_string
    if (typeof object.type === 'string') return object.type
  }
  return null
}

function normalizeActivity(accountId: string, rawActivity: unknown, paymentMethod: MetaPaymentMethod): MetaTransaction | null {
  if (!rawActivity || typeof rawActivity !== 'object') return null
  const activity = rawActivity as Record<string, unknown>
  const eventType = String(activity.event_type ?? activity.type ?? '').toLowerCase()
  const parsedExtraData = parseJsonMaybe(activity.extra_data)
  const extraData = parsedExtraData && typeof parsedExtraData === 'object'
    ? parsedExtraData as Record<string, unknown>
    : {}
  const rawAmount = extraData.amount ?? extraData.total_amount ?? extraData.value ?? extraData.new_value ?? activity.amount
  const currency = String(extraData.currency ?? activity.currency ?? 'USD').trim().toUpperCase()
  const amount = normalizeMetaActivityAmount(rawAmount, currency)
  const paymentDataType = String(extraData.type ?? '').toLowerCase()

  if (eventType !== 'ad_account_billing_charge' || paymentDataType !== 'payment_amount' || amount <= 0) {
    return null
  }

  const eventTime = activity.event_time ?? activity.time ?? activity.created_time
  const transactionId = asText(extraData.transaction_id ?? extraData.transactionId)
  const legacyId = `${accountId}-${eventType}-${String(eventTime ?? '')}`
  const id = String(activity.id ?? transactionId ?? legacyId)

  return {
    id,
    legacyId: transactionId ? legacyId : null,
    amount,
    currency,
    billingDate: metaBillingDateInTimezone(eventTime, paymentMethod.timezoneName),
    status: 'PAID',
    chargeType: asText(activity.event_type),
    productType: 'billing_activity',
    paymentMethod: cleanPaymentMethodLabel(asText(extraData.payment_method ?? extraData.payment_option) ?? paymentMethod.label),
    paymentMethodLast4: parseLast4(extraData.payment_method ?? extraData.payment_option) ?? paymentMethod.last4,
    referenceNumber: asText(extraData.reference_number ?? extraData.reference_id ?? transactionId ?? activity.object_id ?? id),
    receiptUrl: asText(extraData.download_uri ?? extraData.receipt_url),
  }
}

function addDays(date: Date, days: number) {
  const next = new Date(date)
  next.setUTCDate(next.getUTCDate() + days)
  return next
}

function dateOnly(date: Date) {
  return date.toISOString().split('T')[0]
}

function parseDateOnly(value: string) {
  return new Date(`${value}T00:00:00.000Z`)
}

function calendarDayCount(since: string, until: string) {
  return Math.max(1, Math.round((parseDateOnly(until).getTime() - parseDateOnly(since).getTime()) / 86_400_000) + 1)
}

type ActivityRange = { since: Date; until: Date }

function buildActivityRanges(since: string, until: string) {
  const ranges: ActivityRange[] = []
  let cursor = parseDateOnly(since)
  const finalExclusive = addDays(parseDateOnly(until), 1)

  while (cursor < finalExclusive) {
    const rangeEnd = addDays(cursor, ACTIVITY_RANGE_DAYS)
    const boundedEnd = rangeEnd > finalExclusive ? finalExclusive : rangeEnd
    ranges.push({ since: cursor, until: boundedEnd })
    cursor = boundedEnd
  }

  return ranges
}

function splitActivityRange(range: ActivityRange) {
  const durationMs = range.until.getTime() - range.since.getTime()
  if (durationMs <= MIN_ACTIVITY_RANGE_MS) return null

  let midpointMs = Math.floor((range.since.getTime() + Math.floor(durationMs / 2)) / 1_000) * 1_000
  if (midpointMs <= range.since.getTime()) midpointMs = range.since.getTime() + 1_000
  if (midpointMs >= range.until.getTime()) return null
  const midpoint = new Date(midpointMs)
  return [
    { since: range.since, until: midpoint },
    { since: midpoint, until: range.until },
  ] as const
}

function activityRangeLabel(range: ActivityRange) {
  const since = range.since.toISOString()
  const until = range.until.toISOString()
  const fullDays = range.since.getUTCHours() === 0
    && range.until.getUTCHours() === 0
    && range.since.getUTCMinutes() === 0
    && range.until.getUTCMinutes() === 0

  return fullDays
    ? `${dateOnly(range.since)} → ${dateOnly(addDays(range.until, -1))}`
    : `${since.slice(0, 16).replace('T', ' ')}Z → ${until.slice(0, 16).replace('T', ' ')}Z`
}

function shouldSplitActivityRange(error: unknown) {
  return error instanceof MetaGraphError
    && error.code === 1
    && /reduce the amount of data/i.test(error.message)
}

function nextSmallerPageLimit(current: number) {
  return ACTIVITY_PAGE_LIMITS.find(limit => limit < current) ?? null
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error || 'Unknown Meta sync error')
}

function recomputeTotals(job: MetaBillingSyncJob) {
  job.totals = job.accounts.reduce(
    (totals, account) => ({
      pages: totals.pages + account.pages,
      activitiesScanned: totals.activitiesScanned + account.activitiesScanned,
      paidFound: totals.paidFound + account.paidFound,
      synced: totals.synced + account.synced,
    }),
    { pages: 0, activitiesScanned: 0, paidFound: 0, synced: 0 },
  )
}

async function saveJob(job: MetaBillingSyncJob) {
  recomputeTotals(job)
  job.updatedAt = new Date().toISOString()
  await prisma.appSetting.upsert({
    where: { key: JOB_SETTING_KEY },
    create: { key: JOB_SETTING_KEY, value: JSON.stringify(job) },
    update: { value: JSON.stringify(job) },
  })
}

async function readStoredJob() {
  const setting = await prisma.appSetting.findUnique({ where: { key: JOB_SETTING_KEY } })
  if (!setting) return null
  try {
    const parsed = JSON.parse(setting.value) as MetaBillingSyncJob
    if (!parsed?.id || !parsed?.status || !Array.isArray(parsed.accounts)) return null
    parsed.accounts = parsed.accounts.map(account => ({
      ...account,
      currentSince: account.currentSince ?? null,
      currentUntil: account.currentUntil ?? null,
      rangesCompleted: account.rangesCompleted ?? 0,
      rangesTotal: account.rangesTotal ?? 0,
      totalDays: account.totalDays ?? 0,
      daysCompleted: account.daysCompleted ?? 0,
      progressPercent: account.progressPercent ?? 0,
      lastCompletedDate: account.lastCompletedDate ?? null,
      coverageVerified: account.coverageVerified ?? false,
    }))
    return parsed
  } catch {
    return null
  }
}

async function updateRetryProgress(
  job: MetaBillingSyncJob,
  progress: MetaBillingSyncAccountProgress,
  attempt: number,
  delayMs: number,
) {
  progress.retryCount += 1
  progress.message = `Meta đang giới hạn tần suất. Tự thử lại lần ${attempt}/${MAX_RATE_LIMIT_RETRIES} sau ${Math.ceil(delayMs / 1000)} giây.`
  await saveJob(job)
}

async function fetchGraphPage(
  url: string,
  job: MetaBillingSyncJob,
  progress: MetaBillingSyncAccountProgress,
) {
  let attempt = 0

  while (true) {
    let response: Response
    let json: { data?: unknown[]; paging?: { next?: string }; error?: GraphError } & Record<string, unknown>

    try {
      response = await fetch(url, { signal: AbortSignal.timeout(60_000) })
      json = await response.json()
    } catch (error) {
      if (attempt >= MAX_RATE_LIMIT_RETRIES) throw error
      attempt += 1
      const delayMs = Math.min(60_000, 2_000 * (2 ** (attempt - 1)) + Math.floor(Math.random() * 1_000))
      await updateRetryProgress(job, progress, attempt, delayMs)
      await sleep(delayMs)
      continue
    }

    const usagePercent = parseMetaUsagePercent(response.headers)
    if (usagePercent !== null) progress.usagePercent = usagePercent

    if (response.ok && !json.error) {
      return { json, usagePercent }
    }

    if (isMetaRateLimitError(response.status, json.error) && attempt < MAX_RATE_LIMIT_RETRIES) {
      attempt += 1
      const headerDelay = metaPageDelayMs(usagePercent)
      const retryAfterMs = Math.max(0, Number(response.headers.get('retry-after')) || 0) * 1_000
      const delayMs = Math.max(
        headerDelay,
        retryAfterMs,
        Math.min(60_000, 2_000 * (2 ** (attempt - 1)) + Math.floor(Math.random() * 1_000)),
      )
      await updateRetryProgress(job, progress, attempt, delayMs)
      await sleep(delayMs)
      continue
    }

    const message = json.error?.message ?? `HTTP ${response.status}`
    const code = json.error?.code ? ` (code ${json.error.code})` : ''
    throw new MetaGraphError(`Meta API: ${message}${code}`, json.error?.code, response.status)
  }
}

async function fetchPaymentMethod(
  account: MetaAccount,
  job: MetaBillingSyncJob,
  progress: MetaBillingSyncAccountProgress,
): Promise<MetaPaymentMethod> {
  const url = graphUrl(account.accountId, {
    fields: 'funding_source,funding_source_details,currency,timezone_name,balance',
    access_token: account.accessToken,
  })

  try {
    const { json, usagePercent } = await fetchGraphPage(url, job, progress)
    const details = json.funding_source_details
    const object = details && typeof details === 'object' ? details as Record<string, unknown> : {}
    const label = cleanPaymentMethodLabel(asText(object.display_string ?? object.readable_card_type ?? object.card_type ?? object.type))
    const balanceUpdate = buildAccountBalanceUpdate(json as Record<string, unknown>, account.currency ?? null, new Date())
    await sleep(metaPageDelayMs(usagePercent))
    return {
      label,
      last4: parseLast4(object),
      timezoneName: typeof json.timezone_name === 'string' ? json.timezone_name : null,
      ...balanceUpdate,
    }
  } catch {
    // Payment method is optional. Billing activities can still be synchronized without it.
    return { label: null, last4: null, timezoneName: null, balance: null, balanceCurrency: account.currency ?? null, balanceSyncedAt: new Date() }
  }
}

type BillingCoverage = {
  version: 3
  since: string
  until: string
  completedAt: string
}

function coverageSettingKey(accountDbId: string) {
  return `${COVERAGE_SETTING_PREFIX}${accountDbId}`
}

async function readBillingCoverage(accountDbId: string): Promise<BillingCoverage | null> {
  const setting = await prisma.appSetting.findUnique({ where: { key: coverageSettingKey(accountDbId) } })
  if (!setting) return null
  try {
    const parsed = JSON.parse(setting.value) as BillingCoverage
    return parsed?.version === 3 && parsed?.since && parsed?.until ? parsed : null
  } catch {
    return null
  }
}

async function saveBillingCoverage(accountDbId: string, range: { since: string; until: string }) {
  const existing = await readBillingCoverage(accountDbId)
  const coverage: BillingCoverage = {
    version: 3,
    since: existing?.since && existing.since < range.since ? existing.since : range.since,
    until: existing?.until && existing.until > range.until ? existing.until : range.until,
    completedAt: new Date().toISOString(),
  }
  await prisma.appSetting.upsert({
    where: { key: coverageSettingKey(accountDbId) },
    create: { key: coverageSettingKey(accountDbId), value: JSON.stringify(coverage) },
    update: { value: JSON.stringify(coverage) },
  })
}

function validDateKey(value: string | null | undefined) {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null
}

// The first sync should capture full history. Anchor it to the account's linked
// project start (or an explicit env date). Unlinked accounts keep the conservative
// 90-day first-sync window since we have no reliable "beginning" for them.
async function resolveFirstSyncSince(accountDbId: string): Promise<{ since: string; anchored: boolean }> {
  const envSince = validDateKey(process.env.META_BILLING_FIRST_SYNC_SINCE)
  if (envSince) return { since: envSince, anchored: true }

  const account = await prisma.metaAdAccount.findUnique({
    where: { id: accountDbId },
    select: { project: { select: { startDate: true } } },
  })
  if (account?.project?.startDate) return { since: dateOnly(account.project.startDate), anchored: true }

  return { since: dateOnly(addDays(new Date(), -DEFAULT_BACKFILL_DAYS)), anchored: false }
}

async function resolveSyncRange(accountDbId: string) {
  const until = dateOnly(new Date())
  const { since: desiredStart, anchored } = await resolveFirstSyncSince(accountDbId)
  const coverage = await readBillingCoverage(accountDbId)

  // First sync ever → full history from the anchor.
  if (!coverage?.until) {
    return { since: desiredStart > until ? until : desiredStart, until }
  }

  // Subsequent syncs → incremental from the last covered day (minus overlap to re-finalize).
  const incrementalSince = dateOnly(addDays(parseDateOnly(coverage.until), -RESYNC_OVERLAP_DAYS))
  // If an earlier gap is still missing (only when anchored to a real project/env start),
  // extend back once to fill it; coverage.since then advances so later syncs stay incremental.
  const hasFrontGap = anchored && (!coverage.since || coverage.since > desiredStart)
  const since = hasFrontGap ? desiredStart : incrementalSince
  return { since: since > until ? until : since, until }
}

async function upsertTransaction(account: MetaAccount, transaction: MetaTransaction) {
  // The manually imported official export is authoritative. If it already covers
  // this charge, don't add a scraped duplicate. Match on amount within ±1 day
  // because the scrape dates charges in UTC while the export uses the account tz.
  const dupMin = dateOnly(addDays(parseDateOnly(transaction.billingDate), -1))
  const dupMax = dateOnly(addDays(parseDateOnly(transaction.billingDate), 1))
  const importedDuplicate = await prisma.metaBilling.findFirst({
    where: {
      adAccountId: account.id,
      amount: transaction.amount,
      currency: transaction.currency,
      productType: 'meta_billing_export',
      billingDate: { gte: dupMin, lte: dupMax },
    },
    select: { id: true },
  })
  if (importedDuplicate) return

  if (transaction.legacyId && transaction.legacyId !== transaction.id) {
    await prisma.metaBilling.deleteMany({
      where: { id: transaction.legacyId, adAccountId: account.id },
    })
  }

  const values = {
    amount: transaction.amount,
    currency: transaction.currency,
    billingDate: transaction.billingDate,
    status: transaction.status,
    chargeType: transaction.chargeType,
    productType: transaction.productType,
    paymentMethod: transaction.paymentMethod,
    paymentMethodLast4: transaction.paymentMethodLast4,
    referenceNumber: transaction.referenceNumber,
    receiptUrl: transaction.receiptUrl,
  }

  await prisma.metaBilling.upsert({
    where: { id: transaction.id },
    create: { id: transaction.id, adAccountId: account.id, ...values },
    update: values,
  })
}

async function repairLegacyVndActivityAmounts() {
  const completed = await prisma.appSetting.findUnique({ where: { key: VND_AMOUNT_NORMALIZATION_KEY } })
  if (completed) return

  const rows = await prisma.metaBilling.findMany({
    where: {
      currency: 'VND',
      productType: 'billing_activity',
    },
    select: { id: true, amount: true },
  })

  for (const row of rows) {
    await prisma.metaBilling.update({
      where: { id: row.id },
      data: { amount: Math.round(row.amount * 100) },
    })
  }

  await prisma.appSetting.upsert({
    where: { key: VND_AMOUNT_NORMALIZATION_KEY },
    create: {
      key: VND_AMOUNT_NORMALIZATION_KEY,
      value: JSON.stringify({ repaired: rows.length, completedAt: new Date().toISOString() }),
    },
    update: {
      value: JSON.stringify({ repaired: rows.length, completedAt: new Date().toISOString() }),
    },
  })
  console.log(`[meta-billing-sync] Corrected ${rows.length} legacy VND billing amount(s)`)
}

async function syncAccount(job: MetaBillingSyncJob, account: MetaAccount, progress: MetaBillingSyncAccountProgress) {
  progress.status = 'RUNNING'
  job.status = 'RUNNING'
  job.currentAccountId = account.id
  job.currentAccountName = progress.accountName

  const range = progress.since && progress.until
    ? { since: progress.since, until: progress.until }
    : await resolveSyncRange(account.id)
  progress.since = range.since
  progress.until = range.until
  progress.totalDays = calendarDayCount(range.since, range.until)
  progress.message = `Đang chuẩn bị quét từ ${range.since} đến ${range.until}.`
  await saveJob(job)

  const paymentMethod = await fetchPaymentMethod(account, job, progress)
  const ranges = buildActivityRanges(range.since, range.until)
  progress.rangesTotal = ranges.length
  let detectedCurrency: string | null = null
  const seenActivityIds = new Set<string>()

  let rangeIndex = 0
  while (rangeIndex < ranges.length) {
    const activityRange = ranges[rangeIndex]
    progress.currentSince = activityRange.since.toISOString()
    progress.currentUntil = activityRange.until.toISOString()
    let pageLimit = 500
    const useDateOnlyBoundaries = activityRange.since.getUTCHours() === 0
      && activityRange.until.getUTCHours() === 0
      && activityRange.since.getUTCMinutes() === 0
      && activityRange.until.getUTCMinutes() === 0
      && activityRange.until.getTime() - activityRange.since.getTime() >= 86_400_000
    const makeFirstPageUrl = () => graphUrl(`${account.accountId}/activities`, {
      fields: 'id,event_time,event_type,object_id,extra_data',
      since: useDateOnlyBoundaries ? dateOnly(activityRange.since) : activityRange.since.toISOString(),
      until: useDateOnlyBoundaries ? dateOnly(activityRange.until) : activityRange.until.toISOString(),
      limit: String(pageLimit),
      access_token: account.accessToken,
    })
    let nextUrl: string | null = makeFirstPageUrl()

    let splitCurrentRange = false
    while (nextUrl) {
      progress.message = `Đang quét đoạn ${rangeIndex + 1}/${ranges.length} (${activityRangeLabel(activityRange)}), page ${progress.pages + 1}.`
      await saveJob(job)

      let graphPage: Awaited<ReturnType<typeof fetchGraphPage>>
      try {
        graphPage = await fetchGraphPage(nextUrl, job, progress)
      } catch (error) {
        const splitRanges = shouldSplitActivityRange(error)
          ? splitActivityRange(activityRange)
          : null
        if (splitRanges) {
          ranges.splice(rangeIndex, 1, ...splitRanges)
          progress.rangesTotal = ranges.length
          progress.message = `Meta yêu cầu giảm dữ liệu; đã tự chia ${activityRangeLabel(activityRange)} thành dải thời gian nhỏ hơn.`
          await saveJob(job)
          splitCurrentRange = true
          break
        }

        const smallerPageLimit = shouldSplitActivityRange(error)
          ? nextSmallerPageLimit(pageLimit)
          : null
        if (smallerPageLimit !== null) {
          pageLimit = smallerPageLimit
          const smallerPageUrl: URL = new URL(nextUrl)
          smallerPageUrl.searchParams.set('limit', String(pageLimit))
          nextUrl = smallerPageUrl.toString()
          progress.message = `Meta yêu cầu giảm dữ liệu; tự giảm kích thước page xuống ${pageLimit} records.`
          await saveJob(job)
          continue
        }
        throw error
      }

      const { json, usagePercent } = graphPage
      const activities = Array.isArray(json.data) ? json.data : []
      progress.pages += 1

      for (const activity of activities) {
        const activityObject = activity && typeof activity === 'object'
          ? activity as Record<string, unknown>
          : {}
        const activityKey = String(
          activityObject.id
          ?? `${activityObject.event_type ?? ''}-${activityObject.event_time ?? ''}-${activityObject.object_id ?? ''}`,
        )
        if (seenActivityIds.has(activityKey)) continue
        seenActivityIds.add(activityKey)
        progress.activitiesScanned += 1

        const transaction = normalizeActivity(account.accountId, activity, paymentMethod)
        if (!transaction || transaction.billingDate < range.since || transaction.billingDate > range.until) continue
        progress.paidFound += 1
        await upsertTransaction(account, transaction)
        progress.synced += 1
        detectedCurrency ??= transaction.currency.trim().toUpperCase()
      }

      nextUrl = json.paging?.next ?? null
      progress.message = `Đã quét ${progress.activitiesScanned} activity, tìm thấy ${progress.paidFound} billing paid.`
      await saveJob(job)

      if (nextUrl) await sleep(metaPageDelayMs(usagePercent))
    }

    if (splitCurrentRange) continue

    progress.rangesCompleted += 1
    const overallStart = parseDateOnly(range.since).getTime()
    const overallEnd = addDays(parseDateOnly(range.until), 1).getTime()
    const coveredMs = Math.max(0, Math.min(overallEnd, activityRange.until.getTime()) - overallStart)
    const totalMs = Math.max(1, overallEnd - overallStart)
    progress.daysCompleted = Math.min(progress.totalDays, coveredMs / 86_400_000)
    progress.progressPercent = Math.min(99, Math.floor((coveredMs / totalMs) * 100))
    progress.lastCompletedDate = dateOnly(new Date(activityRange.until.getTime() - 1))
    await saveJob(job)
    if (rangeIndex < ranges.length - 1) await sleep(metaPageDelayMs(progress.usagePercent))
    rangeIndex += 1
  }

  await prisma.metaAdAccount.update({
    where: { id: account.id },
    data: {
      lastSyncAt: new Date(),
      ...(!account.currency && detectedCurrency ? { currency: detectedCurrency } : {}),
      balance: paymentMethod.balance,
      balanceCurrency: paymentMethod.balanceCurrency,
      balanceSyncedAt: paymentMethod.balanceSyncedAt,
    },
  })
  await saveBillingCoverage(account.id, range)

  progress.status = 'COMPLETED'
  progress.currentSince = null
  progress.currentUntil = null
  progress.daysCompleted = progress.totalDays
  progress.progressPercent = 100
  progress.lastCompletedDate = range.until
  progress.coverageVerified = true
  progress.message = `Hoàn tất ${progress.pages} page, ${progress.paidFound} billing paid.`
  await saveJob(job)
}

async function runJob(job: MetaBillingSyncJob, accounts: MetaAccount[]) {
  console.log(`[meta-billing-sync] Started job ${job.id} for ${accounts.length} account(s)`)

  for (const account of accounts) {
    const progress = job.accounts.find(item => item.id === account.id)
    if (!progress) continue

    try {
      await syncAccount(job, account, progress)
    } catch (error) {
      progress.status = 'FAILED'
      progress.error = errorMessage(error)
      progress.message = 'Không thể hoàn tất tài khoản này; job tiếp tục với tài khoản kế tiếp.'
      console.error(`[meta-billing-sync] Account ${account.accountId} failed: ${progress.error}`)
      await saveJob(job)
    }
  }

  const failed = job.accounts.filter(account => account.status === 'FAILED')
  job.status = failed.length === 0
    ? 'COMPLETED'
    : failed.length === job.accounts.length ? 'FAILED' : 'COMPLETED_WITH_ERRORS'
  job.currentAccountId = null
  job.currentAccountName = null
  job.finishedAt = new Date().toISOString()
  job.error = failed.length > 0
    ? `${failed.length}/${job.accounts.length} tài khoản sync thất bại.`
    : null
  await saveJob(job)
  console.log(`[meta-billing-sync] Finished job ${job.id}: ${job.status}, ${job.totals.synced} billing(s)`)
}

export async function getMetaBillingSyncJob() {
  const job = await readStoredJob()
  if (!job) return null

  // A persisted RUNNING state without an in-memory worker means Node/PM2 restarted.
  if (isMetaBillingSyncActive(job) && !syncRuntime.worker && !syncRuntime.starting) {
    job.status = 'INTERRUPTED'
    job.currentAccountId = null
    job.currentAccountName = null
    job.finishedAt = new Date().toISOString()
    job.error = 'Tiến trình trước đã dừng do server restart. Dữ liệu đã lưu được giữ nguyên; hãy bấm Sync để chạy tiếp.'
    job.accounts.forEach(account => {
      if (account.status === 'RUNNING') {
        account.status = 'FAILED'
        account.error = job.error
      }
    })
    await saveJob(job)
  }

  return job
}

async function createAndStartJob(accountId?: string | null): Promise<StartMetaBillingSyncResult> {
  const currentJob = await getMetaBillingSyncJob()
  if (currentJob && isMetaBillingSyncActive(currentJob)) {
    return { job: currentJob, alreadyRunning: true }
  }

  await repairLegacyVndActivityAmounts()

  const accounts = await prisma.metaAdAccount.findMany({
    where: accountId ? { id: accountId } : {},
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      accountId: true,
      accountName: true,
      accessToken: true,
      currency: true,
    },
  })

  if (accounts.length === 0) throw new Error('Không tìm thấy tài khoản Meta để sync.')

  const preparedAccounts = await Promise.all(accounts.map(async account => ({
    account,
    range: await resolveSyncRange(account.id),
  })))
  const now = new Date().toISOString()
  const job: MetaBillingSyncJob = {
    id: randomUUID(),
    status: 'QUEUED',
    scopeAccountId: accountId ?? null,
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    totalAccounts: accounts.length,
    currentAccountId: null,
    currentAccountName: null,
    accounts: preparedAccounts.map(({ account, range }) => ({
      id: account.id,
      accountId: account.accountId,
      accountName: account.accountName || account.accountId,
      status: 'QUEUED',
      since: range.since,
      until: range.until,
      currentSince: null,
      currentUntil: null,
      rangesCompleted: 0,
      rangesTotal: 0,
      totalDays: calendarDayCount(range.since, range.until),
      daysCompleted: 0,
      progressPercent: 0,
      lastCompletedDate: null,
      coverageVerified: false,
      pages: 0,
      activitiesScanned: 0,
      paidFound: 0,
      synced: 0,
      usagePercent: null,
      retryCount: 0,
      message: 'Đang chờ xử lý.',
      error: null,
    })),
    totals: { pages: 0, activitiesScanned: 0, paidFound: 0, synced: 0 },
    error: null,
  }

  await saveJob(job)
  syncRuntime.worker = runJob(job, accounts).catch(async error => {
    job.status = 'FAILED'
    job.currentAccountId = null
    job.currentAccountName = null
    job.finishedAt = new Date().toISOString()
    job.error = errorMessage(error)
    await saveJob(job).catch(() => undefined)
    console.error(`[meta-billing-sync] Job ${job.id} failed: ${job.error}`)
  }).finally(() => {
    syncRuntime.worker = null
  })

  return { job, alreadyRunning: false }
}

export async function startMetaBillingSync(accountId?: string | null) {
  if (syncRuntime.starting) return syncRuntime.starting

  const starting = createAndStartJob(accountId)
  syncRuntime.starting = starting
  try {
    return await starting
  } finally {
    syncRuntime.starting = null
  }
}

export function isMetaBillingSyncWorkerActive() {
  return Boolean(syncRuntime.worker || syncRuntime.starting)
}
