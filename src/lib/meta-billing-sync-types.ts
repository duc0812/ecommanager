export type MetaBillingSyncAccountProgress = {
  id: string
  accountId: string
  accountName: string
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED'
  since: string | null
  until: string | null
  currentSince: string | null
  currentUntil: string | null
  rangesCompleted: number
  rangesTotal: number
  totalDays: number
  daysCompleted: number
  progressPercent: number
  lastCompletedDate: string | null
  coverageVerified: boolean
  pages: number
  activitiesScanned: number
  paidFound: number
  synced: number
  usagePercent: number | null
  retryCount: number
  message: string | null
  error: string | null
}

export type MetaBillingSyncJob = {
  id: string
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'COMPLETED_WITH_ERRORS' | 'FAILED' | 'INTERRUPTED'
  scopeAccountId: string | null
  startedAt: string
  updatedAt: string
  finishedAt: string | null
  totalAccounts: number
  currentAccountId: string | null
  currentAccountName: string | null
  accounts: MetaBillingSyncAccountProgress[]
  totals: {
    pages: number
    activitiesScanned: number
    paidFound: number
    synced: number
  }
  error: string | null
}

export function isMetaBillingSyncActive(job: MetaBillingSyncJob | null | undefined) {
  return job?.status === 'QUEUED' || job?.status === 'RUNNING'
}
