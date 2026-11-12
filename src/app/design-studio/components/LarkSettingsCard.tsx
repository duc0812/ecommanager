'use client'
import { useEffect, useState } from 'react'
import { postJson, requestJson } from './model'
import { Card, ErrorBanner, Icon, btn, input } from './ui'
import { secretStatusLabel } from '@/lib/secret-view'

type LarkStatus = {
  enabled: boolean; configured: boolean; appId: string; chatId: string; ownerOpenId: string
  hasAppSecret: boolean; appSecretMasked: string | null
  hasVerificationToken: boolean; verificationTokenMasked: string | null
  hasEncryptKey: boolean; encryptKeyMasked: string | null
}

const URL = '/api/design-agent/settings/lark'

export default function LarkSettingsCard() {
  const [status, setStatus] = useState<LarkStatus | null>(null)
  const [appId, setAppId] = useState('')
  const [appSecret, setAppSecret] = useState('')
  const [verificationToken, setVerificationToken] = useState('')
  const [encryptKey, setEncryptKey] = useState('')
  const [chatId, setChatId] = useState('')
  const [ownerOpenId, setOwnerOpenId] = useState('')
  const [enabled, setEnabled] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')
  const [origin, setOrigin] = useState('')

  function fill(s: LarkStatus) {
    setStatus(s)
    setAppId(s.appId); setChatId(s.chatId); setOwnerOpenId(s.ownerOpenId); setEnabled(s.enabled)
    setAppSecret(''); setVerificationToken(''); setEncryptKey('')
  }

  useEffect(() => {
    setOrigin(window.location.origin)
    let alive = true
    void requestJson<LarkStatus>(URL).then(r => {
      if (!alive) return
      if (!r.ok) { setError(r.error); return }
      fill(r.data)
    })
    return () => { alive = false }
  }, [])

  async function save() {
    setBusy(true); setError(''); setSaved('')
    const r = await postJson<LarkStatus>(URL, { appId, appSecret, verificationToken, encryptKey, chatId, ownerOpenId, enabled })
    setBusy(false)
    if (!r.ok) { setError(r.error); return }
    fill(r.data)
    setSaved('Đã lưu cài đặt Lark.')
  }

  const right = !status ? '' : !status.configured ? 'chưa cấu hình' : status.enabled ? 'đang bật' : 'đang tắt'
  const field = 'flex flex-col gap-xs text-label-sm text-on-surface-variant'

  return (
    <Card icon="forum" title="Lark bot" right={right}>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-md">
        <label className={field}>App ID
          <input className={input} value={appId} onChange={e => setAppId(e.target.value)} autoComplete="off" />
        </label>
        <label className={field}>App Secret
          <input type="password" className={input} value={appSecret} onChange={e => setAppSecret(e.target.value)} autoComplete="new-password"
            placeholder={secretStatusLabel(!!status?.hasAppSecret, status?.appSecretMasked)} />
        </label>
        <label className={field}>Verification Token
          <input type="password" className={input} value={verificationToken} onChange={e => setVerificationToken(e.target.value)} autoComplete="new-password"
            placeholder={secretStatusLabel(!!status?.hasVerificationToken, status?.verificationTokenMasked)} />
        </label>
        <label className={field}>Encrypt Key (không bắt buộc)
          <input type="password" className={input} value={encryptKey} onChange={e => setEncryptKey(e.target.value)} autoComplete="new-password"
            placeholder={secretStatusLabel(!!status?.hasEncryptKey, status?.encryptKeyMasked)} />
        </label>
        <label className={field}>Chat ID của nhóm
          <input className={input} value={chatId} onChange={e => setChatId(e.target.value)} autoComplete="off" />
        </label>
        <label className={field}>Open ID của chủ shop
          <input className={input} value={ownerOpenId} onChange={e => setOwnerOpenId(e.target.value)} autoComplete="off" />
        </label>
      </div>

      <label className="flex items-start gap-sm text-body-sm text-on-surface cursor-pointer">
        <input type="checkbox" className="mt-[3px] w-4 h-4 accent-secondary" checked={enabled} onChange={e => setEnabled(e.target.checked)} aria-label="Bật bot Lark" />
        <span className="flex flex-col">
          <b>Bật bot Lark</b>
          <span className="text-label-sm text-on-surface-variant">
            Khi bật, designer nhắn @bot trong nhóm Lark kèm mã đơn để yêu cầu sửa mẫu, làm mẫu hoặc làm mockup. Kết quả xem trên tool.
          </span>
        </span>
      </label>

      <p className="text-body-sm text-on-surface-variant break-all">{`Event URL điền trong Lark: ${origin}/api/public/lark/events`}</p>

      <div className="flex items-center gap-sm">
        <button type="button" className={btn} disabled={busy || !status} onClick={() => void save()}><Icon name="save" className="text-[16px]" />Lưu cài đặt Lark</button>
        {saved && <span className="text-label-sm text-on-surface-variant" role="status">{saved}</span>}
      </div>
      <ErrorBanner msg={error} onClose={() => setError('')} />
    </Card>
  )
}
