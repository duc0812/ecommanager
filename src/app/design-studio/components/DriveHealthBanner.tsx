'use client'
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { requestJson } from './model'
import { driveBannerItems, type DriveHealthView } from './drive-health-model'
import { Icon, TEXT_TONE } from './ui'

const REFRESH_MS = 60_000

const BOX: Record<string, string> = {
  idle: 'bg-surface-container-low border-outline-variant/30',
  warn: 'bg-amber-100 border-amber-300',
  bad: 'bg-error-container border-error/30',
}

export default function DriveHealthBanner({ version }: { version: number }) {
  const [health, setHealth] = useState<DriveHealthView | null>(null)
  const [pushing, setPushing] = useState(false)
  const [note, setNote] = useState('')

  const load = useCallback(async () => {
    const r = await requestJson<DriveHealthView>('/api/design-studio/drive-health')
    if (r.ok) setHealth(r.data)
  }, [])

  useEffect(() => { load() }, [load, version])
  useEffect(() => {
    const t = setInterval(load, REFRESH_MS)
    return () => clearInterval(t)
  }, [load])

  async function pushNow() {
    setPushing(true); setNote('')
    const r = await requestJson('/api/setup/google-drive/push-local', { method: 'POST' })
    setPushing(false)
    setNote(r.ok ? 'Đang đẩy lên Drive, số file sẽ giảm dần' : r.error)
    window.setTimeout(load, 5000)
  }

  if (!health) return null
  const items = driveBannerItems(health)
  if (items.length === 0) return null

  return (
    <div className="flex flex-wrap items-center gap-sm mb-md" role="status">
      {items.map(item => (
        <div key={item.id} className={`inline-flex items-center gap-xs rounded-lg border px-sm py-xs text-label-sm ${BOX[item.tone] ?? BOX.idle} ${item.tone === 'bad' ? 'text-on-error-container' : TEXT_TONE[item.tone]}`}>
          <Icon name={item.icon} className="text-[16px]" />
          <span>{item.text}</span>
          {item.setupLink && <Link href="/setup" className="text-secondary font-semibold hover:underline">Mở Setup</Link>}
          {item.pushButton && (
            <button type="button" onClick={pushNow} disabled={pushing} className="text-secondary font-semibold hover:underline disabled:opacity-40">
              {pushing ? 'Đang gửi…' : 'Đẩy ngay'}
            </button>
          )}
        </div>
      ))}
      {note && <span className="text-label-sm text-on-surface-variant">{note}</span>}
    </div>
  )
}
