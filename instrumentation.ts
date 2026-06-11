export async function register() {
  // Run in both 'nodejs' runtime and when NEXT_RUNTIME is unset (some dev-mode builds)
  if (!process.env.NEXT_RUNTIME || process.env.NEXT_RUNTIME === 'nodejs') {
    const { initAutoSync } = await import('./src/lib/auto-sync')
    initAutoSync()
  }
}
