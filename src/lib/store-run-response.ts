import { NextResponse } from 'next/server'
import { failedResults, mergeStoreResults, storeRunSummary, type StoreRunResult } from '@/lib/store-jobs'

type Keys<T> = { sum?: Array<keyof T>; concat?: Array<keyof T> }

type Options<T> = {
  notConnected: { error: string; status: number }
  // Status when no store got through; 409 instead when every store was already running the job.
  failureStatus?: number
  // Fields added to a body that has a result.
  extra?: (merged: T, results: StoreRunResult<T>[]) => Record<string, unknown>
  // An error message turns a merged result into a 502 that still carries the whole body.
  rejectMerged?: (merged: T) => string | null
}

// The answer of a manual trigger that ran a job over the connected stores. With one store the body is
// that store's result as it always was; `stores` is added, and `storeErrors` when a store failed.
export function storeRunsResponse<T extends object>(results: StoreRunResult<T>[], keys: Keys<T>, opts: Options<T>) {
  if (results.length === 0) return NextResponse.json({ error: opts.notConnected.error }, { status: opts.notConnected.status })
  const stores = storeRunSummary(results)
  const failed = failedResults(results)
  const merged = mergeStoreResults(results, keys)
  if (!merged) {
    const everySkipped = failed.every(r => r.skipped)
    return NextResponse.json({ error: failed[0].error, stores }, { status: everySkipped ? 409 : opts.failureStatus ?? 502 })
  }
  const body = {
    ...merged,
    ...(opts.extra ? opts.extra(merged, results) : {}),
    ...(failed.length > 0 ? { storeErrors: failed.map(r => `${r.shop}: ${r.error}`) } : {}),
    stores,
  }
  const rejected = opts.rejectMerged?.(merged)
  if (rejected) return NextResponse.json({ error: rejected, ...body }, { status: 502 })
  return NextResponse.json(body)
}
