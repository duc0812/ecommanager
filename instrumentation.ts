export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { initAutoSync } = await import('./src/lib/auto-sync')
    initAutoSync()
  }
}
