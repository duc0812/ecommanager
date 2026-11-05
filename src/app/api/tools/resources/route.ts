import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAccess, requireSuperadmin } from '@/lib/api-auth'
import { sendTelegramMessage } from '@/lib/telegram'
import { proxyDisplayName, proxySnapshotMessage, reconcileProxyStatuses, refreshProxyStatus, sendProxyRenewalAlerts } from '@/lib/proxy-maintenance'

function csv(value: any) {
  return String(value ?? '').split(',').map(v => v.trim()).filter(Boolean).join(',')
}

function clean(value: any) {
  return String(value ?? '').trim()
}

function cleanHost(value: any) {
  return clean(value).toLowerCase()
}

// The password stays on the server: the page gets `hasPassword`, and only POST /api/tools/resources/reveal returns the value.
function proxyView<T extends { password: string | null }>(proxy: T) {
  const { password, ...rest } = proxy
  return { ...rest, hasPassword: Boolean(password) }
}

async function findDuplicateProxy(host: string, port: string, excludeId?: string | null) {
  if (!host || !port) return null
  return prisma.resourceProxy.findFirst({
    where: {
      host,
      port,
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
  })
}

export async function GET(req: NextRequest) {
  const auth = await requireApiAccess(req)
  if ('error' in auth) return auth.error
  await Promise.all([reconcileProxyStatuses(), sendProxyRenewalAlerts()])
  const [proxies, accounts] = await Promise.all([
    prisma.resourceProxy.findMany({ include: { accounts: true }, orderBy: { createdAt: 'desc' } }),
    prisma.toolAccount.findMany({ include: { proxy: true }, orderBy: { createdAt: 'desc' } }),
  ])
  return NextResponse.json({
    proxies: proxies.map(proxyView),
    accounts: accounts.map(account => ({ ...account, proxy: account.proxy ? proxyView(account.proxy) : null })),
  })
}

export async function POST(req: NextRequest) {
  const auth = await requireSuperadmin(req)
  if ('error' in auth) return auth.error
  const body = await req.json()
  if (body.kind === 'proxy') {
    const host = cleanHost(body.host)
    const port = clean(body.port)
    if (!host || !port) return NextResponse.json({ error: 'Proxy host and port are required' }, { status: 400 })
    const duplicate = await findDuplicateProxy(host, port)
    if (duplicate) {
      return NextResponse.json({ error: `Proxy ${host}:${port} already exists` }, { status: 409 })
    }
    const proxy = await prisma.resourceProxy.create({
      data: {
        name: clean(body.name) || `${host}:${port}`,
        host,
        port,
        username: clean(body.username) || null,
        password: clean(body.password) || null,
        provider: clean(body.provider) || null,
        tags: csv(body.tags),
        purchaseDate: body.purchaseDate || null,
        expireDate: body.expireDate || null,
        status: body.status || 'CANCEL',
        note: body.note || null,
      },
    })
    await refreshProxyStatus(proxy.id)
    return NextResponse.json({ ok: true, proxy: proxyView(proxy) })
  }

  if (body.kind === 'account') {
    const account = await prisma.toolAccount.create({
      data: {
        email: String(body.email ?? '').trim(),
        accountCode: String(body.accountCode ?? '').trim(),
        accountType: String(body.accountType ?? '').trim(),
        status: body.status || 'ACTIVE',
        proxyId: body.status === 'DIE' ? null : body.proxyId || null,
        tags: csv(body.tags),
        note: body.note || null,
      },
    })
    await refreshProxyStatus(body.proxyId || null)
    return NextResponse.json({ ok: true, account })
  }

  return NextResponse.json({ error: 'Invalid kind' }, { status: 400 })
}

export async function PATCH(req: NextRequest) {
  const auth = await requireSuperadmin(req)
  if ('error' in auth) return auth.error
  const body = await req.json()
  if (body.kind === 'proxy') {
    const host = cleanHost(body.host)
    const port = clean(body.port)
    if (!host || !port) return NextResponse.json({ error: 'Proxy host and port are required' }, { status: 400 })
    const duplicate = await findDuplicateProxy(host, port, body.id)
    if (duplicate) {
      return NextResponse.json({ error: `Proxy ${host}:${port} already exists` }, { status: 409 })
    }
    const old = await prisma.resourceProxy.findUnique({ where: { id: body.id }, include: { accounts: true } })
    const password = clean(body.password)
    const proxy = await prisma.resourceProxy.update({
      where: { id: body.id },
      data: {
        name: clean(body.name) || `${host}:${port}`,
        host,
        port,
        username: clean(body.username) || null,
        ...(password ? { password } : {}),
        provider: clean(body.provider) || null,
        tags: csv(body.tags),
        status: body.status,
        purchaseDate: body.purchaseDate || null,
        expireDate: body.expireDate || null,
        note: body.note || null,
      },
    })
    const hadNoActiveAccounts = !old?.accounts.some(account => account.status === 'ACTIVE')
    if (body.status === 'CANCEL' && old?.status !== 'CANCEL' && hadNoActiveAccounts) {
      await sendTelegramMessage(await proxySnapshotMessage({ type: 'cancel', name: proxyDisplayName(proxy) }))
    }
    await refreshProxyStatus(proxy.id)
    return NextResponse.json({ ok: true, proxy: proxyView(proxy) })
  }

  if (body.kind === 'account') {
    const old = await prisma.toolAccount.findUnique({ where: { id: body.id } })
    const status = body.status || old?.status || 'ACTIVE'
    const account = await prisma.toolAccount.update({
      where: { id: body.id },
      data: {
        email: String(body.email ?? old?.email ?? '').trim(),
        accountCode: String(body.accountCode ?? old?.accountCode ?? '').trim(),
        accountType: String(body.accountType ?? old?.accountType ?? '').trim(),
        status,
        proxyId: status === 'DIE' ? null : body.proxyId || null,
        tags: csv(body.tags ?? old?.tags),
        note: body.note || null,
      },
    })
    await refreshProxyStatus(old?.proxyId || null)
    await refreshProxyStatus(account.proxyId || null)
    return NextResponse.json({ ok: true, account })
  }

  return NextResponse.json({ error: 'Invalid kind' }, { status: 400 })
}

export async function DELETE(req: NextRequest) {
  const auth = await requireSuperadmin(req)
  if ('error' in auth) return auth.error
  const { kind, id } = await req.json()
  if (kind === 'account') {
    const old = await prisma.toolAccount.findUnique({ where: { id } })
    await prisma.toolAccount.delete({ where: { id } })
    await refreshProxyStatus(old?.proxyId || null)
  }
  if (kind === 'proxy') await prisma.resourceProxy.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}
