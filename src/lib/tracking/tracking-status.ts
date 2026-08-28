export type TrackingCheckpoint = {
  time: string
  desc: string
  status: string
}

export type InternalTrackingSnapshot = {
  version: 1
  status: string
  checkpoints: TrackingCheckpoint[]
}

const STATUS_PATTERNS: Array<{ status: string; patterns: RegExp[] }> = [
  {
    status: 'FAILED_ATTEMPT',
    patterns: [
      /delivery attempt (?:was )?failed/,
      /failed delivery attempt/,
      /giao hang khong thanh cong/,
    ],
  },
  {
    status: 'OUT_FOR_DELIVERY',
    patterns: [
      /out for delivery/,
      /with (?:the )?(?:local )?(?:delivery )?courier/,
      /dang giao hang/,
    ],
  },
  {
    status: 'DELIVERED',
    patterns: [
      /\bdelivered\b/,
      /delivery completed/,
      /giao hang thanh cong/,
      /da giao hang/,
    ],
  },
  {
    status: 'EXCEPTION',
    patterns: [
      /\bexception\b/,
      /return(?:ed)? to sender/,
      /held (?:at|by) customs/,
      /customs (?:issue|delay|hold)/,
      /van de giao hang/,
    ],
  },
  {
    status: 'EXPIRED',
    patterns: [/\bexpired\b/, /tracking (?:has )?expired/],
  },
  {
    status: 'IN_TRANSIT',
    patterns: [
      /\bin transit\b/,
      /\bon the way\b/,
      /departed (?:from|the)/,
      /arrived at/,
      /dang van chuyen/,
    ],
  },
  {
    status: 'INFO_RECEIVED',
    patterns: [
      /info(?:rmation)? received/,
      /shipment information (?:has been )?received/,
      /label created/,
      /pre[- ]shipment/,
      /da nhan thong tin/,
    ],
  },
]

function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

function detectFromText(value: string): string | null {
  const normalized = normalizeText(value)
  if (!normalized) return null
  for (const candidate of STATUS_PATTERNS) {
    if (candidate.patterns.some(pattern => pattern.test(normalized))) return candidate.status
  }
  return null
}

export function detectInternalStatus(statusSignals: string[], bodyText = ''): string {
  for (const signal of statusSignals) {
    const detected = detectFromText(signal)
    if (detected) return detected
  }
  return detectFromText(bodyText.slice(0, 5000)) ?? 'PENDING'
}

export function buildInternalTrackingSnapshot(
  status: string,
  checkpoints: TrackingCheckpoint[],
): InternalTrackingSnapshot {
  return { version: 1, status, checkpoints }
}

export function parseInternalTrackingSnapshot(value: string | null): InternalTrackingSnapshot | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value)
    if (!parsed || Array.isArray(parsed) || parsed.version !== 1 || typeof parsed.status !== 'string') return null
    return {
      version: 1,
      status: parsed.status,
      checkpoints: Array.isArray(parsed.checkpoints) ? parsed.checkpoints : [],
    }
  } catch {
    return null
  }
}

export function parseTrackingCheckpoints(value: string | null): TrackingCheckpoint[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    if (Array.isArray(parsed)) return parsed
    return Array.isArray(parsed?.checkpoints) ? parsed.checkpoints : []
  } catch {
    return []
  }
}
