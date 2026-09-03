// libsql's local-file driver opens every connection with busy_timeout=0 and exposes no
// config for it, so a writer meeting another writer fails instantly with SQLITE_BUSY.
// WAL journal mode (applied to the DB file itself) removes reader/writer contention;
// these retries cover the residual writer/writer case — effectively busy_timeout ≈ 1.5s.
export const BUSY_RETRY_DELAYS_MS = [50, 100, 200, 400, 800]

export function isBusyError(e: any): boolean {
  const code = e?.code ?? e?.cause?.code
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') return true
  const msg = `${e?.message ?? ''} ${e?.cause?.message ?? ''}`.toLowerCase()
  return msg.includes('database is locked') || msg.includes('sqlite_busy') || msg.includes('sqlite_locked')
}

export async function retryOnBusy<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run()
    } catch (e) {
      if (attempt >= BUSY_RETRY_DELAYS_MS.length || !isBusyError(e)) throw e
      await new Promise(resolve => setTimeout(resolve, BUSY_RETRY_DELAYS_MS[attempt]))
    }
  }
}
