import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'

const schedule = vi.fn()
vi.mock('node-cron', () => ({ default: { schedule: (...args: unknown[]) => schedule(...args) } }))

const savedFlag = process.env.DISABLE_SCHEDULERS
const initKeys = () => (globalThis as typeof globalThis & { __initOnce?: Set<string> }).__initOnce

beforeEach(() => {
  schedule.mockClear()
  initKeys()?.delete('design-task-sync-scheduler')
})
afterAll(() => {
  if (savedFlag === undefined) delete process.env.DISABLE_SCHEDULERS
  else process.env.DISABLE_SCHEDULERS = savedFlag
})

describe('design task sync scheduler', () => {
  it('registers one 15-minute job, however often it is initialised', async () => {
    const { initDesignTaskSyncScheduler, DESIGN_TASK_SYNC_CRON } = await import('@/lib/design-task-sync-scheduler')
    initDesignTaskSyncScheduler()
    initDesignTaskSyncScheduler()
    expect(DESIGN_TASK_SYNC_CRON).toBe('*/15 * * * *')
    expect(schedule).toHaveBeenCalledTimes(1)
    expect(schedule.mock.calls[0][0]).toBe('*/15 * * * *')
  })

  it('register() starts nothing while DISABLE_SCHEDULERS=1', async () => {
    process.env.DISABLE_SCHEDULERS = '1'
    const { register } = await import('@/instrumentation')
    await register()
    expect(schedule).not.toHaveBeenCalled()
    expect(initKeys()?.has('design-task-sync-scheduler') ?? false).toBe(false)
  })
})
