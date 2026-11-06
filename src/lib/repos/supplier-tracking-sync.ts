import { syncBondreTracking } from '@/lib/repos/bondre-push'
import { syncPrintwayTracking } from '@/lib/repos/printway-push'
import { syncMerchizeTracking } from '@/lib/repos/merchize-push'

export type ApiTrackingResult = { name: string; pushes?: number; found?: number; shipments?: number; skipped?: string; error?: string }

const SYNCS = [
  { name: 'Bondre', run: syncBondreTracking },
  { name: 'Printway', run: syncPrintwayTracking },
  { name: 'Merchize', run: syncMerchizeTracking },
]

/** Every supplier whose tracking is read one order at a time. One failing does not stop the others. */
export async function syncApiSupplierTracking(): Promise<ApiTrackingResult[]> {
  const out: ApiTrackingResult[] = []
  for (const { name, run } of SYNCS) {
    try {
      out.push({ name, ...(await run()) })
    } catch (e: any) {
      out.push({ name, error: e?.message ?? String(e) })
    }
  }
  return out
}
