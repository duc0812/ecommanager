import { prisma } from '@/lib/db'
import { sendTelegramMessage } from '@/lib/telegram'

type ProxyWithAccounts = {
  id: string
  name: string
  host?: string | null
  port?: string | null
  tags?: string | null
  provider?: string | null
  purchaseDate?: string | null
  expireDate?: string | null
  accounts: Array<{
    email: string
    accountCode: string
    accountType: string
    status: string
  }>
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function proxyDisplayName(proxy: { name: string; host?: string | null; port?: string | null }) {
  return proxy.name || [proxy.host, proxy.port].filter(Boolean).join(':')
}

function proxyLabel(proxy: ProxyWithAccounts) {
  const hostPort = [proxy.host, proxy.port].filter(Boolean).join(':')
  const parts = [proxyDisplayName(proxy)]
  if (hostPort && hostPort !== proxyDisplayName(proxy)) parts.push(hostPort)
  if (proxy.provider) parts.push(proxy.provider)
  return escapeHtml(parts.join(' | '))
}

function accountLabel(account: ProxyWithAccounts['accounts'][number]) {
  const parts = [
    account.email,
    account.accountCode,
    account.accountType,
  ].filter(Boolean)
  return escapeHtml(parts.join(' | '))
}

function dateKey(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function parseDateOnly(value?: string | null) {
  if (!value) return null
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(year, month - 1, day)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null
  date.setHours(0, 0, 0, 0)
  return date
}

function addMonthsClamped(date: Date, months: number) {
  const next = new Date(date)
  const desiredDay = next.getDate()
  next.setDate(1)
  next.setMonth(next.getMonth() + months)
  const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate()
  next.setDate(Math.min(desiredDay, lastDay))
  next.setHours(0, 0, 0, 0)
  return next
}

function daysBetween(start: Date, end: Date) {
  return Math.round((end.getTime() - start.getTime()) / 86400000)
}

function nextMonthlyRenewalDate(startDate: Date, today: Date) {
  let renewalDate = addMonthsClamped(startDate, 1)
  while (renewalDate < today) {
    renewalDate = addMonthsClamped(renewalDate, 1)
  }
  return renewalDate
}

async function getProxyGroups() {
  await reconcileProxyStatuses()
  const proxies = await prisma.resourceProxy.findMany({
    include: { accounts: true },
    orderBy: { name: 'asc' },
  })

  return {
    cancel: proxies.filter(proxy => !proxy.accounts.some(account => account.status === 'ACTIVE')),
    maintain: proxies.filter(proxy => proxy.accounts.some(account => account.status === 'ACTIVE')),
  }
}

export async function buildProxyRenewalMessage(proxies: Array<ProxyWithAccounts & { renewalDate: Date }>) {
  const lines = [
    '<b>Proxy renewal reminder</b>',
    '',
    `These proxies need renewal tomorrow (${proxies.length}):`,
    ...proxies.map(proxy => `- ${proxyLabel(proxy)} - renew by ${dateKey(proxy.renewalDate)}${proxy.tags ? ` (${escapeHtml(proxy.tags)})` : ''}`),
  ]
  return lines.join('\n')
}

export async function sendProxyRenewalAlerts(today = new Date()) {
  today.setHours(0, 0, 0, 0)
  const proxies = await prisma.resourceProxy.findMany({
    where: { purchaseDate: { not: null } },
    include: { accounts: true },
    orderBy: { name: 'asc' },
  })
  const dueTomorrow = proxies
    .map(proxy => {
      const startDate = parseDateOnly(proxy.purchaseDate)
      if (!startDate) return null
      const renewalDate = proxy.expireDate
        ? parseDateOnly(proxy.expireDate)
        : nextMonthlyRenewalDate(startDate, today)
      if (!renewalDate || daysBetween(today, renewalDate) !== 1) return null
      return { ...proxy, renewalDate }
    })
    .filter((proxy): proxy is NonNullable<typeof proxy> => Boolean(proxy))

  if (dueTomorrow.length === 0) return { sent: false, count: 0 }

  const key = `telegram.proxyRenewalAlerts.${dateKey(today)}`
  const setting = await prisma.appSetting.findUnique({ where: { key } })
  const sentIds = new Set<string>(setting?.value ? JSON.parse(setting.value) : [])
  const pending = dueTomorrow.filter(proxy => !sentIds.has(proxy.id))
  if (pending.length === 0) return { sent: false, count: 0 }

  const result = await sendTelegramMessage(await buildProxyRenewalMessage(pending))
  if ('error' in result && result.error) return { sent: false, count: pending.length, error: result.error }
  if (result.skipped) return { sent: false, count: pending.length, skipped: true }

  const nextSentIds = Array.from(new Set([...Array.from(sentIds), ...pending.map(proxy => proxy.id)]))
  await prisma.appSetting.upsert({
    where: { key },
    create: { key, value: JSON.stringify(nextSentIds) },
    update: { value: JSON.stringify(nextSentIds) },
  })

  return { sent: true, count: pending.length }
}

export async function buildProxyCheckMessage() {
  const { cancel, maintain } = await getProxyGroups()
  const lines = [
    '<b>Proxy maintain check</b>',
    '',
    `<b>Can cancel (${cancel.length})</b>`,
    ...(cancel.length
      ? cancel.map(proxy => `- ${proxyLabel(proxy)}${proxy.tags ? ` (${escapeHtml(proxy.tags)})` : ''}`)
      : ['- none']),
    '',
    `<b>Still linked to active accounts (${maintain.length})</b>`,
    ...(maintain.length
      ? maintain.flatMap(proxy => {
          const activeAccounts = proxy.accounts.filter(account => account.status === 'ACTIVE')
          return [
            `- ${proxyLabel(proxy)} - ${activeAccounts.length} active`,
            ...activeAccounts.map(account => `  + ${accountLabel(account)}`),
          ]
        })
      : ['- none']),
  ]

  return lines.join('\n')
}

export async function proxySnapshotMessage(change?: { type: 'cancel' | 'maintain'; name: string }) {
  const { cancel, maintain } = await getProxyGroups()
  const title = change?.type === 'cancel'
    ? `Proxy marked for cancellation: ${escapeHtml(change.name)}`
    : change?.type === 'maintain'
      ? `Proxy no longer needs cancellation: ${escapeHtml(change.name)}`
      : 'Proxy cancellation update'

  const lines = [
    `<b>${title}</b>`,
    '',
    'Cancel:',
    ...(cancel.length ? cancel.map(proxy => `- ${proxyLabel(proxy)} (${escapeHtml(proxy.tags || 'no tags')})`) : ['- none']),
    '',
    'Maintain:',
    ...(maintain.length
      ? maintain.map(proxy => `- ${proxyLabel(proxy)} (${escapeHtml(proxy.tags || 'no tags')}) - active accounts: ${proxy.accounts.filter(account => account.status === 'ACTIVE').length}`)
      : ['- none']),
  ]
  return lines.join('\n')
}

export async function refreshProxyStatus(proxyId: string | null) {
  if (!proxyId) return
  const proxy = await prisma.resourceProxy.findUnique({ where: { id: proxyId }, include: { accounts: true } })
  if (!proxy) return
  const hasActiveAccount = proxy.accounts.some(account => account.status === 'ACTIVE')
  if (!hasActiveAccount && proxy.status !== 'CANCEL') {
    await prisma.resourceProxy.update({ where: { id: proxyId }, data: { status: 'CANCEL' } })
    await sendTelegramMessage(await proxySnapshotMessage({ type: 'cancel', name: proxyDisplayName(proxy) }))
  }
  if (hasActiveAccount && proxy.status === 'CANCEL') {
    await prisma.resourceProxy.update({ where: { id: proxyId }, data: { status: 'MAINTAIN' } })
    await sendTelegramMessage(await proxySnapshotMessage({ type: 'maintain', name: proxyDisplayName(proxy) }))
  }
}

export async function reconcileProxyStatuses() {
  const proxies = await prisma.resourceProxy.findMany({ include: { accounts: true } })
  await Promise.all(proxies.map(proxy => {
    const hasActiveAccount = proxy.accounts.some(account => account.status === 'ACTIVE')
    const status = hasActiveAccount ? 'MAINTAIN' : 'CANCEL'
    if (proxy.status === status) return Promise.resolve()
    return prisma.resourceProxy.update({ where: { id: proxy.id }, data: { status } })
  }))
}
