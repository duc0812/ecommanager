import { prisma } from '@/lib/db'

const META_EXCHANGE_RATE_PREFIX = 'meta.exchangeRate.'

export function metaExchangeRateKey(adAccountId: string) {
  return `${META_EXCHANGE_RATE_PREFIX}${adAccountId}`
}

export function parseMetaExchangeRate(value: string | null | undefined) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

export async function getMetaExchangeRates(adAccountIds: string[]) {
  if (adAccountIds.length === 0) return new Map<string, number>()
  const keys = adAccountIds.map(metaExchangeRateKey)
  const settings = await prisma.appSetting.findMany({ where: { key: { in: keys } } })
  const result = new Map<string, number>()

  for (const setting of settings) {
    const rate = parseMetaExchangeRate(setting.value)
    if (rate !== null) {
      result.set(setting.key.slice(META_EXCHANGE_RATE_PREFIX.length), rate)
    }
  }
  return result
}

export async function saveMetaExchangeRate(adAccountId: string, exchangeRate: number | null) {
  const key = metaExchangeRateKey(adAccountId)
  if (!exchangeRate || !Number.isFinite(exchangeRate) || exchangeRate <= 0) {
    await prisma.appSetting.deleteMany({ where: { key } })
    return
  }
  await prisma.appSetting.upsert({
    where: { key },
    create: { key, value: String(exchangeRate) },
    update: { value: String(exchangeRate) },
  })
}
