import { describe, it, expect, afterAll } from 'vitest'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { generateWorkerToken, revokeWorkerToken } from '@/lib/artwork-worker'
import { requireDeliveryWorker, DELIVERY_SWITCH_KEY } from '@/lib/delivery/guard'

const req = (token?: string) =>
  new NextRequest('http://localhost/api/design-studio/worker/delivery/x', {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })

async function setSwitch(value: string | null) {
  if (value === null) await prisma.appSetting.deleteMany({ where: { key: DELIVERY_SWITCH_KEY } })
  else
    await prisma.appSetting.upsert({
      where: { key: DELIVERY_SWITCH_KEY },
      update: { value },
      create: { key: DELIVERY_SWITCH_KEY, value },
    })
}

describe('requireDeliveryWorker', () => {
  afterAll(async () => {
    await setSwitch(null)
    await revokeWorkerToken()
  })

  it('401 without a token', async () => {
    await setSwitch('true')
    const res = await requireDeliveryWorker(req())
    expect(res?.status).toBe(401)
    expect(await res?.json()).toEqual({ error: 'Unauthorized' })
  })

  it('503 disabled when the switch is missing', async () => {
    const token = await generateWorkerToken()
    await setSwitch(null)
    const res = await requireDeliveryWorker(req(token))
    expect(res?.status).toBe(503)
    expect((await res?.json()).code).toBe('disabled')
  })

  it('null when token valid and switch on', async () => {
    const token = await generateWorkerToken()
    await setSwitch('true')
    expect(await requireDeliveryWorker(req(token))).toBeNull()
  })

  it('401 for a wrong token with the switch on', async () => {
    await generateWorkerToken()
    await setSwitch('true')
    const res = await requireDeliveryWorker(req('dsw_wrong'))
    expect(res?.status).toBe(401)
  })
})
