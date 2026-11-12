import { describe, it, expect, afterAll } from 'vitest'
import { prisma } from '@/lib/db'
import { getDesignSettings, saveAgentSettings, normalizeAgentSettings, DEFAULT_AGENT_SETTINGS } from '@/lib/design-settings'
import { PUT } from '@/app/api/design-studio/settings/route'
import { superRequest, dropSessionUser } from './helpers/session'

afterAll(async () => {
  await prisma.appSetting.deleteMany({ where: { key: 'design.settings' } })
  await prisma.designAgentJob.deleteMany({ where: { requestText: 'x', source: 'REJECT', kind: 'FIX' } })
  await dropSessionUser()
})

describe('design agent settings', () => {
  it('agent settings default OFF and survive a settings save that does not send them', async () => {
    await prisma.appSetting.deleteMany({ where: { key: 'design.settings' } })
    expect((await getDesignSettings()).agent).toEqual({ autoFixOnReject: false, maxConcurrent: 5, leaseMinutes: 20 })
    await saveAgentSettings({ autoFixOnReject: true, maxConcurrent: 3 })
    const res = await PUT(await superRequest('http://localhost/api/design-studio/settings', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slaCustomHours: 24, slaNonCustomHours: 48, kpiByType: { default: 0.3 }, rejectReasons: ['Sai chi tiết'] }),
    }))
    expect(res.status).toBe(200)
    expect((await getDesignSettings()).agent).toEqual({ autoFixOnReject: true, maxConcurrent: 3, leaseMinutes: 20 })
  })

  it('normalizeAgentSettings clamps', () => {
    expect(normalizeAgentSettings({ autoFixOnReject: 'yes', maxConcurrent: 99, leaseMinutes: 0 })).toEqual({ autoFixOnReject: false, maxConcurrent: 10, leaseMinutes: 5 })
    expect(normalizeAgentSettings(null)).toEqual(DEFAULT_AGENT_SETTINGS)
  })

  it('DesignAgentJob row defaults', async () => {
    const j = await prisma.designAgentJob.create({ data: { kind: 'FIX', source: 'REJECT', requestText: 'x' } })
    expect(j).toMatchObject({ status: 'QUEUED', priority: 0, rounds: 0, attempts: 0, libraryState: null, taskId: null })
  })
})
