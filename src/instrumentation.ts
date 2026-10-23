export async function register() {
  // Run in both 'nodejs' runtime and when NEXT_RUNTIME is unset (some dev-mode builds)
  // A local copy of the prod DB carries live Shopify/Trello credentials; DISABLE_SCHEDULERS=1 keeps
  // that machine from running the same jobs as the server and creating duplicate cards or fulfillments.
  if (process.env.DISABLE_SCHEDULERS === '1') return
  if (!process.env.NEXT_RUNTIME || process.env.NEXT_RUNTIME === 'nodejs') {
    const { initAutoSync } = await import('./lib/auto-sync')
    initAutoSync()
    const { initSpyScheduler } = await import('./lib/spy/scheduler')
    initSpyScheduler()
    const { initTrackingScheduler } = await import('./lib/tracking/scheduler')
    initTrackingScheduler()
    const { initOrderNormalizeScheduler } = await import('./lib/order-normalize-scheduler')
    initOrderNormalizeScheduler()
    const { initParcelPanelScheduler } = await import('./lib/tracking/parcelpanel-scheduler')
    initParcelPanelScheduler()
    const { initAutoFulfillScheduler } = await import('./lib/fulfillment/auto-fulfill-scheduler')
    initAutoFulfillScheduler()
    const { initCashflowSnapshotScheduler } = await import('./lib/cashflow-snapshot-scheduler')
    initCashflowSnapshotScheduler()
    const { initDailySyncScheduler } = await import('./lib/daily-sync-scheduler')
    initDailySyncScheduler()
    const { initDesignTaskSyncScheduler } = await import('./lib/design-task-sync-scheduler')
    initDesignTaskSyncScheduler()
    const { initDrivePushScheduler } = await import('./lib/drive-push-scheduler')
    initDrivePushScheduler()
    const { initCsScheduler } = await import('./lib/cs/scheduler')
    initCsScheduler()
  }
}
