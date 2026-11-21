export type TrackingNumberItem = {
  number: string
  carrier: string | null
  url: string
  lineKeys: string[]
  lastMile: boolean
  status: string | null
}

const STATUS_TONE: Record<string, string> = {
  DELIVERED: 'border-emerald-500',
  OUT_FOR_DELIVERY: 'border-sky-500',
  IN_TRANSIT: 'border-sky-500',
  EXCEPTION: 'border-error',
  EXPIRED: 'border-error',
}

export default function TrackingNumbers({ items }: { items: TrackingNumberItem[] | undefined }) {
  if (!items || items.length === 0) return null
  const showLines = new Set(items.map(t => t.lineKeys.join(','))).size > 1
  return (
    <div className="mt-[4px] flex flex-col gap-[3px]" data-testid="tracking-numbers">
      {items.map(t => {
        const meta = [t.carrier, t.lastMile ? 'last mile' : null, showLines ? t.lineKeys.map(k => k.replace(/^.*_/, '_')).join(' ') : null]
          .filter(Boolean).join(' · ')
        return (
          <a
            key={t.number}
            href={t.url}
            target="_blank"
            rel="noreferrer"
            onClick={e => e.stopPropagation()}
            title={[t.number, t.carrier, t.lastMile ? 'last mile' : null, t.status, t.lineKeys.join(', ')].filter(Boolean).join(' · ')}
            className={`block border-l-2 pl-[4px] text-[10px] leading-tight hover:underline ${STATUS_TONE[t.status ?? ''] ?? 'border-outline-variant'}`}
          >
            <span className="block break-all font-mono text-secondary">{t.number}</span>
            {meta && <span className="block text-on-surface-variant">{meta}</span>}
          </a>
        )
      })}
    </div>
  )
}
