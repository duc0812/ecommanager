import { NextResponse } from 'next/server'
import { DriveAuthError, DriveError } from '@/lib/google-drive'
import { DriveTimeoutError } from '@/lib/delivery/drive'

export const DRIVE_RETRY_AFTER_SEC = 30

export const DRIVE_BUSY_MESSAGE = 'Google Drive đang chậm hoặc quá tải — thử lại sau'

export function isDriveBusy(err: unknown): boolean {
  return err instanceof DriveTimeoutError || (err instanceof DriveError && !(err instanceof DriveAuthError) && (err.status === 429 || err.status >= 500))
}

export function driveBusyResponse(error: string = DRIVE_BUSY_MESSAGE) {
  return NextResponse.json({ error, code: 'busy' }, { status: 503, headers: { 'Retry-After': String(DRIVE_RETRY_AFTER_SEC) } })
}

/** The answer for a Drive failure the machine can act on: stop (not connected) or retry later (busy); null for anything else. */
export function driveFailureResponse(err: unknown): NextResponse | null {
  if (err instanceof DriveAuthError) {
    return NextResponse.json({ error: 'Google Drive chưa kết nối', code: 'drive_not_connected' }, { status: 503 })
  }
  if (isDriveBusy(err)) return driveBusyResponse(`${DRIVE_BUSY_MESSAGE}: ${(err as Error).message}`)
  return null
}
