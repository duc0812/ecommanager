export async function register() {
  // Run in both 'nodejs' runtime and when NEXT_RUNTIME is unset (some dev-mode builds)
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
  }
}
