export type DeliveryAction = 'push' | 'replace' | 'retire' | 'revert'

export type DeliveryFile = {
  kind: 'PRINT' | 'MOCKUP'
  printArea: string
  fileName: string
  driveFileId: string
  shortcutOf?: string | null
  size: number
  mimeType: string
  widthPx?: number | null
  heightPx?: number | null
}

export type TaskState = {
  taskKey: string
  status: string
  readiness: string
  orderOpen: boolean
  sent: boolean
  folder: { id: string; url: string }
  incomingFolder: { id: string }
  artworks: {
    id: string
    kind: string
    printArea: string
    version: number
    source: string
    uploadedById: string | null
    driveFileId: string | null
    sharedWith: number
  }[]
  nextVersion: Record<string, number>
  required: string[]
}

export type CommitInput = {
  action: DeliveryAction
  expected: { status: string; liveIds: string[] }
  files: DeliveryFile[]
  retire: string[]
  retireSources?: ('AUTO' | 'MANUAL')[]
  allowFinished?: boolean
  revertReadiness?: 'MANUAL' | 'LOW'
  eventMessage?: string
  dryRun?: boolean
  /** push/replace only: once the task reaches REVIEW it is approved as `delivery.localApprover`; needs the X-Delivery-Approve token. */
  approve?: boolean
}

export type CommitResult = {
  ok: true
  status: string
  /** `id` is null on a dryRun row that would be inserted. */
  artworks: { id: string | null; kind: string; printArea: string; version: number; driveFileId: string | null }[]
  retired: string[]
  missing: string[]
  warnings: string[]
  alreadyApplied: boolean
  /** dryRun with approve: the commit would take the task to REVIEW and the approval would follow. */
  wouldApprove?: boolean
}

export type CommitError = {
  ok: false
  error: string
  code: string
  httpStatus: 400 | 404 | 409 | 503
  current?: TaskState
}
