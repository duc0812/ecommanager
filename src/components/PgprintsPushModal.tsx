'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Lightbox } from '@/app/design-studio/components/Lightbox'
import { ErrorBanner, Icon, Note, Pill, btn, btnPrimary } from '@/app/design-studio/components/ui'
import type { LightboxImage, Tone } from '@/app/design-studio/components/model'
import type { PreviewFile, PreviewIssue, PushPreview, PushStatus, PushView } from '@/lib/pgprints-shared'
import type { SupplierApiKind } from '@/lib/handoff-shared'
import type { ToadditPreviewInfo } from '@/lib/toaddit-shared'

type Estimate = { goods: number | null; wallet: number | null; note: string }
type Preview = PushPreview & { canAct: boolean; canSend?: boolean; estimate?: Estimate | null; toaddit?: ToadditPreviewInfo }
type Payload = {
  order_id: string
  logistics?: Record<string, string>
  first_name?: string
  last_name?: string
  address_1?: string
  address_2?: string
  city?: string
  region?: string
  zip?: string
  country?: string
  phone?: string
  email?: string
  shipping_address?: Record<string, string>
  shipping_info?: Record<string, string>
  packages?: Array<Record<string, any>>
  shippingAddress?: Record<string, string>
  firstName?: string
  lastName?: string
  shipping_phone?: string
  shipping_address1?: string
  shipping_address2?: string
  shipping_city?: string
  shipping_province_code?: string
  shipping_zip?: string
  shipping_country?: string
  shipping_country_code?: string
  production_note?: string
}

type SupplierCopy = { name: string; settingsHint: string; credentialsHint: string; methodLabel: string; noMethod: string | null; chargeNote: string }

const SUPPLIERS: Record<SupplierApiKind, SupplierCopy> = {
  toaddit: {
    name: 'Toaddit', settingsHint: 'Chưa lưu API key Toaddit ROS ở Setup › Fulfill', credentialsHint: 'Chưa lưu API key Toaddit ROS ở Setup › Fulfill',
    methodLabel: 'Ship', noMethod: 'Standard', chargeNote: 'Toaddit ROS nhận sản phẩm, size, file in và mockup đã duyệt',
  },
  printposs: {
    name: 'Printposs', settingsHint: 'Chưa lưu token Printposs ở Setup › Fulfill', credentialsHint: 'Chưa lưu token Printposs ở Setup › Fulfill',
    methodLabel: 'Ship', noMethod: 'Printposs xử lý', chargeNote: 'Printposs tạo đơn; kiểm tra trạng thái thanh toán trên tài khoản Printposs',
  },
  pgprints: {
    name: 'PGprints', settingsHint: 'Chưa bật gửi đơn ở trang cài đặt xưởng Pgprints', credentialsHint: 'Chưa nhập Store ID / Secret key PGprints',
    methodLabel: 'Ship class', noMethod: null, chargeNote: 'PGprints sẽ trừ tiền sau thời gian chờ',
  },
  merchize: {
    name: 'Merchize', settingsHint: 'Server chưa có khoá API Merchize', credentialsHint: 'Server chưa có MERCHIZE_API_URL / MERCHIZE_API_TOKEN',
    methodLabel: 'Kiểu in', noMethod: 'không cần', chargeNote: 'Merchize đưa đơn vào sản xuất ngay và trừ tiền',
  },
  bondre: {
    name: 'Bondre', settingsHint: 'Chưa lưu tài khoản Bondre ở Setup › Fulfill', credentialsHint: 'Chưa lưu tài khoản Bondre ở Setup › Fulfill',
    methodLabel: 'Ship', noMethod: null, chargeNote: 'Bondre tạo đơn ngay, đơn ở trạng thái chưa thanh toán, trả tiền trên Bondre',
  },
  printway: {
    name: 'Printway', settingsHint: 'Chưa lưu token Printway ở Setup › Fulfill', credentialsHint: 'Chưa lưu token Printway ở Setup › Fulfill',
    methodLabel: 'Ship', noMethod: 'Printway tự chọn', chargeNote: 'Printway tạo đơn và trừ tiền ngay trong tài khoản Printway',
  },
  catkissfish: {
    name: 'CatKissFish', settingsHint: 'Chưa lưu client_id / client_secret CatKissFish ở Setup › Fulfill', credentialsHint: 'Chưa lưu client_id / client_secret CatKissFish ở Setup › Fulfill',
    methodLabel: 'Ship', noMethod: null, chargeNote: 'CatKissFish tạo đơn, tool không tự trả tiền: đơn "Chưa thanh toán" phải trả trên catkissfish.com mới vào sản xuất',
  },
  lenful: {
    name: 'Lenful', settingsHint: 'Chưa lưu API key Lenful ở Setup › Fulfill', credentialsHint: 'Chưa lưu API key Lenful ở Setup › Fulfill',
    methodLabel: 'Mã ship', noMethod: 'Lenful mặc định', chargeNote: 'Lenful tạo đơn và tự trừ tiền ví Lenful (ví thiếu thì đơn chờ thanh toán, tự trừ khi nạp)',
  },
}

const statusMeta = (name: string): Record<PushStatus, { label: string; tone: Tone; icon: string }> => ({
  SENDING: { label: 'Chưa rõ kết quả', tone: 'warn', icon: 'help' },
  CREATED: { label: `Đã gửi ${name}`, tone: 'ok', icon: 'check_circle' },
  FAILED: { label: 'Gửi thất bại', tone: 'bad', icon: 'error' },
  CANCELLED: { label: `Đã huỷ bên ${name}`, tone: 'idle', icon: 'cancel' },
})

const usd = (n: number | null | undefined) =>
  n == null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'

async function call(url: string, init?: RequestInit): Promise<{ ok: true; data: any } | { ok: false; error: string; data: any }> {
  try {
    const res = await fetch(url, init)
    const data = await res.json().catch(() => null)
    if (!res.ok) return { ok: false, error: data?.error ?? `Lỗi ${res.status}`, data }
    return { ok: true, data }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'Không kết nối được máy chủ', data: null }
  }
}

const postInit = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

function sizeLabel(f: PreviewFile): { text: string; tone: Tone } {
  const have = f.widthPx && f.heightPx ? `${f.widthPx}×${f.heightPx}` : 'chưa đọc được px'
  const need = f.expectedWidthPx && f.expectedHeightPx ? `${f.expectedWidthPx}×${f.expectedHeightPx}` : 'chưa có template'
  return { text: `${have} / khổ ${need}`, tone: f.sizeOk === true ? 'ok' : f.sizeOk === false ? 'warn' : 'idle' }
}

function Thumb({ url, label, onOpen }: { url: string | null; label: string; onOpen: () => void }) {
  if (!url) {
    return (
      <span className="w-16 h-16 shrink-0 rounded-lg border border-outline-variant/40 bg-surface-container-low grid place-items-center text-on-surface-variant" title={label}>
        <Icon name="image_not_supported" className="text-[20px]" />
      </span>
    )
  }
  return (
    <button type="button" onClick={onOpen} title={`Xem ${label}`}
      className="w-16 h-16 shrink-0 rounded-lg border border-outline-variant/40 bg-surface-container-low grid place-items-center overflow-hidden hover:border-secondary">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt={label} className="max-w-full max-h-full object-contain" />
    </button>
  )
}

function IssueList({ issues }: { issues: PreviewIssue[] }) {
  if (issues.length === 0) return null
  const errors = issues.filter(i => i.level === 'error')
  const warnings = issues.filter(i => i.level === 'warning')
  return (
    <div className="flex flex-col gap-xs">
      {errors.length > 0 && (
        <Note tone="bad" icon="block">
          <b>{errors.length} lỗi chặn gửi</b>
          <ul className="list-disc pl-md">{errors.map((i, n) => <li key={`${i.code}-${n}`}>{i.message}</li>)}</ul>
        </Note>
      )}
      {warnings.length > 0 && (
        <Note tone="warn" icon="warning">
          <b>{warnings.length} cảnh báo</b>
          <ul className="list-disc pl-md">{warnings.map((i, n) => <li key={`${i.code}-${n}`}>{i.message}</li>)}</ul>
        </Note>
      )}
    </div>
  )
}

function PushPanel({ push, canAct, busy, name, onRefresh, onCancel, supportsCancel = true }: {
  push: PushView; canAct: boolean; busy: string; name: string; onRefresh: () => void; onCancel: () => void; supportsCancel?: boolean
}) {
  const meta = statusMeta(name)[push.status]
  const [confirmCancel, setConfirmCancel] = useState(false)
  return (
    <section className="rounded-xl border border-secondary/30 bg-secondary/5 px-md py-sm flex flex-col gap-sm">
      <div className="flex items-center gap-sm flex-wrap">
        <Pill tone={meta.tone} icon={meta.icon}>{meta.label}</Pill>
        <span className="text-body-sm text-on-surface-variant">Mã đơn {name}</span>
        <b className="font-mono text-body-md">{push.supplierOrderCode ?? '—'}</b>
        <span className="text-body-sm text-on-surface-variant">· order_id <span className="font-mono">{push.externalOrderId}</span></span>
      </div>
      <dl className="grid grid-cols-2 md:grid-cols-4 gap-sm text-body-sm">
        <div><dt className="text-label-sm text-on-surface-variant">Tổng chi phí</dt><dd className="font-semibold">{usd(push.totalCost)}</dd></div>
        <div><dt className="text-label-sm text-on-surface-variant">Phí ship</dt><dd>{usd(push.shippingFee)}</dd></div>
        <div><dt className="text-label-sm text-on-surface-variant">Phí xử lý</dt><dd>{usd(push.handleFee)}</dd></div>
        <div><dt className="text-label-sm text-on-surface-variant">Trạng thái bên xưởng</dt><dd>{push.remoteStatus ?? 'chưa cập nhật'}</dd></div>
        <div><dt className="text-label-sm text-on-surface-variant">Gửi lúc</dt><dd>{when(push.pushedAt)}</dd></div>
        <div><dt className="text-label-sm text-on-surface-variant">Người gửi</dt><dd>{push.pushedByName ?? '—'}</dd></div>
        <div><dt className="text-label-sm text-on-surface-variant">Cập nhật gần nhất</dt><dd>{when(push.lastSyncedAt)}</dd></div>
      </dl>
      {push.error && <Note tone="warn" icon="warning">{push.error}</Note>}
      {canAct ? (
        <div className="flex items-center gap-sm flex-wrap">
          <button type="button" className={btn} disabled={!!busy} onClick={onRefresh}>
            <Icon name="sync" className="text-[18px]" />{busy === 'refresh' ? 'Đang cập nhật…' : 'Cập nhật trạng thái'}
          </button>
          {supportsCancel && push.status === 'CREATED' && !confirmCancel && (
            <button type="button" className={`${btn} text-error`} disabled={!!busy} onClick={() => setConfirmCancel(true)}>
              <Icon name="cancel" className="text-[18px]" />Huỷ đơn bên {name}
            </button>
          )}
          {supportsCancel && push.status === 'CREATED' && confirmCancel && (
            <span className="inline-flex items-center gap-xs flex-wrap rounded-lg bg-error-container text-on-error-container px-sm py-xs text-label-sm">
              Huỷ đơn {push.supplierOrderCode ?? push.externalOrderId} bên {name}?
              <button type="button" className={`${btn} text-error`} disabled={!!busy} onClick={() => { setConfirmCancel(false); onCancel() }}>
                {busy === 'cancel' ? 'Đang huỷ…' : 'Huỷ thật'}
              </button>
              <button type="button" className={btn} disabled={!!busy} onClick={() => setConfirmCancel(false)}>Không</button>
            </span>
          )}
        </div>
      ) : (
        <span className="text-label-sm text-on-surface-variant">Chỉ Admin được huỷ hoặc cập nhật trạng thái đơn bên {name}.</span>
      )}
    </section>
  )
}

export default function PgprintsPushModal({ orderId, supplier = 'pgprints', onClose, onChanged }: {
  orderId: string; supplier?: SupplierApiKind; onClose: () => void; onChanged?: () => void
}) {
  const copy = SUPPLIERS[supplier]
  const name = copy.name
  const STATUS_META = statusMeta(name)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [busy, setBusy] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [variantIds, setVariantIds] = useState<Record<string, string>>({})
  const [browseRosCatalog, setBrowseRosCatalog] = useState(false)
  const [showPayload, setShowPayload] = useState(false)
  const [lightbox, setLightbox] = useState<number | null>(null)
  const base = `/api/fulfillment/${supplier}/orders/${encodeURIComponent(orderId)}`

  const load = useCallback(async () => {
    setLoading(true)
    if (supplier === 'toaddit') setConfirming(false)
    const query = supplier === 'toaddit' ? `?variantIds=${encodeURIComponent(JSON.stringify(variantIds))}&catalog=${browseRosCatalog ? 1 : 0}` : ''
    const r = await call(`${base}/preview${query}`)
    setLoading(false)
    if (!r.ok) { setError(r.error); return }
    setPreview(r.data)
  }, [base, supplier, variantIds, browseRosCatalog])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape' && lightbox === null) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, lightbox])

  const images = useMemo<LightboxImage[]>(() => {
    if (!preview) return []
    const out: LightboxImage[] = []
    for (const line of preview.lines) {
      for (const f of line.files) if (f.thumbUrl) out.push({ url: f.thumbUrl, label: `${line.refId} · file in ${f.area}`, openUrl: f.viewUrl, copyUrl: f.publicUrl ?? f.viewUrl })
      if (line.mockupUrl) out.push({ url: line.mockupUrl, label: `${line.refId} · mockup` })
    }
    return out
  }, [preview])
  const openImage = (url: string | null) => {
    const i = url ? images.findIndex(m => m.url === url) : -1
    if (i >= 0) setLightbox(i)
  }

  async function act(kind: 'push' | 'cancel' | 'refresh', body: unknown, done: (data: any) => string) {
    setBusy(kind); setError(''); setInfo('')
    const r = await call(`${base}/${kind}`, postInit(body))
    setBusy('')
    if (r.ok) setInfo(done(r.data))
    else setError(r.error)
    setConfirming(false)
    await load()
    onChanged?.()
  }

  const send = () => act('push', { confirm: true, payloadHash: preview?.payloadHash, ...(supplier === 'toaddit' ? { variantIds } : {}) }, d =>
    `Đã gửi ${name} — mã ${d.push?.supplierOrderCode ?? d.push?.externalOrderId ?? '—'}${d.push?.totalCost != null ? `, chi phí ${usd(d.push.totalCost)}` : ''}${d.exported ? ', đơn chuyển sang Exported' : ''}`)
  const cancelPush = () => act('cancel', { confirm: true }, d =>
    `Đã huỷ đơn bên ${name}${d.exportReverted ? ' — đơn trở lại trạng thái trước khi gửi' : ''}`)
  const refreshPush = () => act('refresh', {}, d =>
    d.found ? `Trạng thái bên xưởng: ${d.push?.remoteStatus ?? 'không rõ'}` : `${name} không trả về đơn này`)

  const payload = preview?.payload as Payload | null | undefined
  const shipInfo = payload?.shipping_info
  const pack = payload?.packages?.[0]
  const ckf = payload?.shippingAddress
  const lf = supplier === 'lenful' ? payload?.shipping_address : undefined
  const flat = payload?.shipping_address1 ? {
    name: `${payload.firstName ?? ''} ${payload.lastName ?? ''}`.trim(), address1: payload.shipping_address1, address2: payload.shipping_address2, city: payload.shipping_city,
    province_code: payload.shipping_province_code, zip: payload.shipping_zip, country: payload.shipping_country, country_code: payload.shipping_country_code, phone: payload.shipping_phone,
  } as Record<string, string> : undefined
  const ppAddress = supplier === 'printposs' && payload ? {
    name: `${payload.first_name ?? ''} ${payload.last_name ?? ''}`.trim(), address1: payload.address_1, address2: payload.address_2,
    city: payload.city, province_code: payload.region, zip: payload.zip, country: payload.country, phone: payload.phone,
  } as Record<string, string> : undefined
  const td = supplier === 'toaddit' ? payload?.logistics : undefined
  const tdAddress: Record<string, string> | undefined = td ? { name: td.consignee, address1: td.address1, address2: td.address2, city: td.city, province_code: td.province, zip: td.postcode, country: td.countryCode, country_code: td.countryCode, phone: td.phone } : undefined
  const address = tdAddress ?? ppAddress ?? (lf ? {
    name: lf.name, address1: lf.line1, address2: lf.line2, city: lf.city, province_code: lf.state_code,
    zip: lf.postal, country: lf.country_code, country_code: lf.country_code, phone: lf.phone,
  } as Record<string, string> : undefined) ?? flat ?? payload?.shipping_address ?? (ckf ? {
    name: ckf.userName, address1: ckf.detailAddress, city: ckf.city, province_code: ckf.province,
    zip: ckf.postalCode, country: ckf.countryAbbreviation, country_code: ckf.countryAbbreviation, phone: ckf.phone,
  } as Record<string, string> : undefined) ?? (pack ? {
    name: pack.recipientName, address1: pack.streetAddress, city: pack.city, province_code: pack.stateCode,
    zip: pack.postcode, country: pack.countryCode, country_code: pack.countryCode, phone: pack.phoneNumber,
  } as Record<string, string> : undefined) ?? (shipInfo ? {
    name: shipInfo.full_name, address1: shipInfo.address_1, address2: shipInfo.address_2, city: shipInfo.city, province_code: shipInfo.state,
    zip: shipInfo.postcode, country: shipInfo.country, country_code: shipInfo.country, phone: shipInfo.phone, email: shipInfo.email,
  } as Record<string, string> : undefined)
  const email = payload?.email ?? shipInfo?.email ?? ckf?.email
  const errors = preview?.issues.filter(i => i.level === 'error') ?? []
  const active = preview?.activePush ?? null
  // A line approved after the live push went out: the push stays shown, and the new line can still go.
  const sendable = !active || !!preview?.laterSend
  const pastPushes = preview?.history.filter(h => h.id !== active?.id) ?? []
  const canSend = !!preview && (preview.canSend ?? preview.canAct)
  const blockedReason = !preview ? '' : !canSend ? `Chỉ Admin hoặc người có quyền CSV Export được gửi đơn sang ${name}`
    : preview.storeNote ? preview.storeNote
    : !preview.pushEnabled ? copy.settingsHint
    : !preview.hasCredentials ? copy.credentialsHint
    : errors.length > 0 ? 'Sửa hết lỗi chặn gửi trước' : ''

  return (
    <div role="dialog" aria-modal="true" aria-label={`Gửi đơn sang ${name}`} className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-lg">
      <div className="max-h-[92vh] w-full max-w-5xl overflow-auto rounded-xl bg-surface-container-lowest shadow-xl">
        <div className="sticky top-0 z-10 flex items-center gap-sm border-b border-outline-variant/20 bg-surface-container-lowest px-lg py-md">
          <Icon name="local_shipping" className="text-secondary text-[22px]" />
          <h2 className="text-headline-sm font-semibold">Gửi {name}</h2>
          {preview && <span className="font-mono text-body-md">{preview.order.shopifyOrderNumber}</span>}
          {preview && <span className="text-body-sm text-on-surface-variant">· {preview.order.storeName}</span>}
          <button type="button" onClick={onClose} className={`${btn} ml-auto`}><Icon name="close" className="text-[18px]" />Đóng</button>
        </div>

        <div className="p-lg flex flex-col gap-md">
          {info && <Note tone="ok" icon="check_circle">{info}</Note>}
          <ErrorBanner msg={error} onClose={() => setError('')} />
          {loading && !preview && <p className="text-body-sm text-on-surface-variant">Đang dựng bản xem trước…</p>}

          {preview && active && <PushPanel push={active} canAct={preview.canAct} busy={busy} name={name} onRefresh={refreshPush} onCancel={cancelPush} supportsCancel={supplier !== 'printposs'} />}
          {supplier === 'printposs' && active && <Note tone="warn" icon="info">API Printposs chưa hỗ trợ huỷ đơn. Liên hệ xưởng để huỷ và đối chiếu trước khi gửi lại.</Note>}
          {preview?.toaddit && sendable && <section className="rounded-xl border border-secondary/30 p-md space-y-md">
            <h3 className="text-body-md font-semibold">Sản phẩm và size Toaddit ROS</h3>
            {!browseRosCatalog && !preview.toaddit.options.length && <button type="button" className={btn} disabled={!!busy || loading || !canSend} onClick={() => setBrowseRosCatalog(true)}>Đổi sản phẩm hoặc size</button>}
            <p className="text-body-sm text-on-surface-variant">Chọn đúng mã sản phẩm và size của xưởng. File in trọn sheet và mockup đã duyệt ở dưới sẽ được gửi kèm đơn, gồm đúng nội dung cá nhân hoá.</p>
            {preview.lines.map(line => {
              const product = preview.toaddit!.products.find(t => t.shopifyLineId === line.shopifyLineId)
              return <label key={line.shopifyLineId} className="block text-label-sm">{line.refId} · Sản phẩm / size
                <select className="mt-xs w-full border rounded-lg px-sm py-xs text-body-sm" value={product?.variantId ?? ''} disabled={!!busy || loading || !canSend}
                  onChange={e => { const value = e.target.value; setVariantIds(old => ({ ...old, [line.shopifyLineId]: value })) }}>
                  <option value="" disabled>Chọn sản phẩm và size từ catalog ROS</option>
                  {product && !preview.toaddit!.options.some(t => t.id === product.variantId) && <option value={product.variantId}>{product.productCode} · {product.size} · {product.name}</option>}
                  {preview.toaddit!.options.map(t => <option key={t.id} value={t.id}>{t.productCode} · {t.size} · {t.name}</option>)}
                </select>
              </label>
            })}
          </section>}

          {preview && sendable && (
            <>
              {preview.storeNote ? <Note tone="warn" icon="key_off">{preview.storeNote}</Note> : (
                <>
                  {supplier === 'pgprints' && !preview.pushEnabled && (
                    <Note tone="warn" icon="toggle_off">Gửi đơn sang PGprints đang tắt. Super Admin bật ở trang cài đặt xưởng Pgprints — bản xem trước vẫn dùng được.</Note>
                  )}
                  {!preview.hasCredentials && <Note tone="warn" icon="key_off">{copy.credentialsHint}.</Note>}
                </>
              )}
              <IssueList issues={preview.issues} />
            </>
          )}

          {preview && (
            <div className="grid gap-md lg:grid-cols-[minmax(0,1fr)_300px]">
              <section className="rounded-xl border border-outline-variant/20">
                <div className="flex items-center gap-sm px-md py-sm border-b border-outline-variant/20 text-body-sm font-semibold">
                  <Icon name="inventory_2" className="text-on-surface-variant text-[18px]" />
                  <span>Dòng gửi xưởng ({preview.lines.length})</span>
                </div>
                <ul className="divide-y divide-outline-variant/20">
                  {preview.lines.map(line => (
                    <li key={line.refId} className="px-md py-sm flex flex-col gap-sm">
                      <div className="flex items-start gap-sm flex-wrap">
                        <span className="font-mono text-body-sm font-semibold">{line.refId}</span>
                        <span className="flex-1 min-w-[180px] text-body-sm">{line.productTitle}{line.variantTitle ? ` · ${line.variantTitle}` : ''}</span>
                        <span className="text-body-sm text-on-surface-variant">SL <b className="text-on-surface">{line.quantity}</b></span>
                      </div>
                      <div className="flex items-center gap-sm flex-wrap text-label-sm">
                        <span className="text-on-surface-variant">SKU xưởng</span><span className="font-mono">{line.supplierSku ?? '—'}</span>
                        <Icon name="arrow_forward" className="text-[14px] text-on-surface-variant" />
                        <span className="text-on-surface-variant">SKU API</span>
                        {line.apiSku ? <span className="font-mono font-semibold">{line.apiSku}</span> : <Pill tone="bad" icon="error">chưa map</Pill>}
                        <span className="text-on-surface-variant">· {copy.methodLabel}</span>
                        {line.shipClass
                          ? <span>{line.shipClass}{line.shipClassSource === 'default' ? <span className="text-on-surface-variant"> (mặc định)</span> : null}</span>
                          : copy.noMethod
                            ? <span className="text-on-surface-variant">{copy.noMethod}</span>
                            : <Pill tone="bad" icon="error">thiếu</Pill>}
                        {line.shipCountries.length > 0 && <span className="text-on-surface-variant">· chỉ giao tới <b className="text-on-surface">{line.shipCountries.join(', ')}</b></span>}
                        {line.templateName && <span className="text-on-surface-variant">· template {line.templateName}</span>}
                      </div>
                      <div className="flex items-start gap-md flex-wrap">
                        {line.files.map(f => {
                          const size = sizeLabel(f)
                          return (
                            <div key={f.area} className="flex items-center gap-sm">
                              <Thumb url={f.thumbUrl} label={`file in ${f.area}`} onOpen={() => openImage(f.thumbUrl)} />
                              <div className="flex flex-col text-label-sm min-w-0">
                                <b className="text-on-surface">File in · {f.area}</b>
                                <span className="text-on-surface-variant truncate max-w-[220px]">{f.fileName ?? 'chưa có file'}</span>
                                {f.artworkId && <Pill tone={size.tone}>{size.text}</Pill>}
                              </div>
                            </div>
                          )
                        })}
                        <div className="flex items-center gap-sm">
                          <Thumb url={line.mockupUrl} label="mockup" onOpen={() => openImage(line.mockupUrl)} />
                          <div className="flex flex-col text-label-sm">
                            <b className="text-on-surface">Mockup</b>
                            <span className="text-on-surface-variant">{line.mockupUrl ? 'gửi kèm cho xưởng' : 'không có'}</span>
                          </div>
                        </div>
                      </div>
                      {line.designNote && <span className="text-label-sm text-on-surface-variant">Ghi chú sản xuất: <span className="text-on-surface whitespace-pre-wrap">{line.designNote}</span></span>}
                    </li>
                  ))}
                  {preview.lines.length === 0 && <li className="px-md py-md text-body-sm text-on-surface-variant">Đơn không có dòng nào của {name}.</li>}
                </ul>
              </section>

              <div className="flex flex-col gap-md">
                <section className="rounded-xl border border-outline-variant/20 px-md py-sm">
                  <h3 className="flex items-center gap-xs text-body-sm font-semibold mb-xs"><Icon name="home_pin" className="text-on-surface-variant text-[18px]" />Địa chỉ giao</h3>
                  {address ? (
                    <div className="text-body-sm space-y-[2px]">
                      <p className="font-semibold">{address.name}</p>
                      {address.first_name !== undefined && <p className="text-label-sm text-on-surface-variant">Tên: {address.first_name} · Họ: {address.last_name}</p>}
                      <p>{address.address1}</p>
                      {address.address2 && <p>{address.address2}</p>}
                      <p>{[address.city, address.province_code || address.province, address.zip].filter(Boolean).join(', ')}</p>
                      <p>{address.country} ({address.country_code || '—'})</p>
                      <p className="text-on-surface-variant">{address.phone || 'không có số điện thoại'}</p>
                      {!pack && !flat && <p className="text-on-surface-variant">{email || 'không có email'}</p>}
                    </div>
                  ) : <p className="text-body-sm text-on-surface-variant">Chưa dựng được nội dung gửi — xem lỗi phía trên.</p>}
                </section>

                {preview.estimate && <section className="rounded-xl border border-outline-variant/20 px-md py-sm">
                  <h3 className="flex items-center gap-xs text-body-sm font-semibold mb-xs"><Icon name="account_balance_wallet" className="text-on-surface-variant text-[18px]" />Tiền ước tính</h3>
                  <dl className="text-body-sm space-y-[2px]">
                    <div className="flex justify-between"><dt className="text-on-surface-variant">Phôi (giá catalog)</dt><dd className="font-semibold">{usd(preview.estimate.goods)}</dd></div>
                    <div className="flex justify-between"><dt className="text-on-surface-variant">Ví {name}</dt><dd>{usd(preview.estimate.wallet)}</dd></div>
                  </dl>
                  <p className="mt-xs text-label-sm text-on-surface-variant">{preview.estimate.note}</p>
                </section>}

                {supplier === 'pgprints' && <section className="rounded-xl border border-outline-variant/20 px-md py-sm">
                  <h3 className="flex items-center gap-xs text-body-sm font-semibold mb-xs"><Icon name="account_balance_wallet" className="text-on-surface-variant text-[18px]" />Số dư PGprints</h3>
                  {preview.balance ? (
                    <dl className="text-body-sm space-y-[2px]">
                      <div className="flex justify-between"><dt className="text-on-surface-variant">Khả dụng</dt><dd className="font-semibold">{usd(preview.balance.availableAmount)}</dd></div>
                      <div className="flex justify-between"><dt className="text-on-surface-variant">Đang giữ</dt><dd>{usd(preview.balance.pendingAmount)}</dd></div>
                      <div className="flex justify-between"><dt className="text-on-surface-variant">Sắp trừ</dt><dd>{usd(preview.balance.upcomingAmount)}</dd></div>
                      <div className="flex justify-between"><dt className="text-on-surface-variant">Đã trả</dt><dd>{usd(preview.balance.paidAmount)}</dd></div>
                    </dl>
                  ) : <p className="text-body-sm text-on-surface-variant">Không lấy được số dư.</p>}
                </section>}
              </div>
            </div>
          )}

          {preview?.payload != null && (
            <section className="rounded-xl border border-outline-variant/20">
              <button type="button" onClick={() => setShowPayload(v => !v)} aria-expanded={showPayload}
                className="w-full flex items-center gap-sm px-md py-sm text-body-sm font-semibold text-left">
                <Icon name={showPayload ? 'expand_less' : 'expand_more'} className="text-[18px] text-on-surface-variant" />
                Nội dung gửi sang {name} (đúng từng ký tự)
              </button>
              {showPayload && <pre className="px-md pb-md text-[11px] leading-snug font-mono overflow-auto max-h-[320px] whitespace-pre-wrap break-all">{JSON.stringify(preview.payload, null, 2)}</pre>}
            </section>
          )}

          {pastPushes.length > 0 && (
            <section className="rounded-xl border border-outline-variant/20 px-md py-sm">
              <h3 className="flex items-center gap-xs text-body-sm font-semibold mb-xs">
                <Icon name="history" className="text-on-surface-variant text-[18px]" />Các lần gửi trước
                {!active && preview?.canAct && pastPushes[0].status === 'FAILED' && (
                  <button type="button" className={`${btn} ml-auto`} disabled={!!busy} onClick={refreshPush} title={`Hỏi ${name} xem lần gửi lỗi gần nhất có thật sự tạo đơn không`}>
                    <Icon name="sync" className="text-[16px]" />{busy === 'refresh' ? 'Đang kiểm tra…' : `Kiểm tra lại bên ${name}`}
                  </button>
                )}
              </h3>
              <ul className="flex flex-col gap-xs text-label-sm">
                {pastPushes.map(h => (
                  <li key={h.id} className="flex items-center gap-sm flex-wrap">
                    <Pill tone={STATUS_META[h.status].tone} icon={STATUS_META[h.status].icon}>{STATUS_META[h.status].label}</Pill>
                    <span className="font-mono">{h.supplierOrderCode ?? h.externalOrderId}</span>
                    <span className="text-on-surface-variant">{when(h.pushedAt)}{h.pushedByName ? ` · ${h.pushedByName}` : ''}</span>
                    {h.error && <span className="text-error">{h.error}</span>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {preview && sendable && (
            <div className="flex items-center justify-end gap-sm flex-wrap border-t border-outline-variant/20 pt-md">
              {blockedReason && <span className="text-label-sm text-on-surface-variant mr-auto">{blockedReason}</span>}
              <button type="button" className={btn} disabled={loading || !!busy} onClick={() => void load()}>
                <Icon name="refresh" className="text-[18px]" />{loading ? 'Đang tải…' : 'Dựng lại bản xem trước'}
              </button>
              {!confirming ? (
                <button type="button" className={btnPrimary} disabled={!preview.canPush || !canSend || !!busy || loading} title={blockedReason || undefined} onClick={() => setConfirming(true)}>
                  <Icon name="send" className="text-[18px]" />Xác nhận gửi
                </button>
              ) : (
                <span className="inline-flex items-center gap-sm flex-wrap rounded-lg bg-amber-100 text-amber-900 px-sm py-xs text-label-sm">
                  <Icon name="payments" className="text-[18px]" />
                  Đơn thật — {copy.chargeNote}. Gửi {preview.order.shopifyOrderNumber}?
                  <button type="button" className={btnPrimary} disabled={!!busy || loading} onClick={send}>
                    <Icon name="send" className="text-[18px]" />{busy === 'push' ? 'Đang gửi…' : 'Gửi đơn thật'}
                  </button>
                  <button type="button" className={btn} disabled={!!busy} onClick={() => setConfirming(false)}>Chưa gửi</button>
                </span>
              )}
            </div>
          )}
        </div>
      </div>
      {lightbox !== null && <Lightbox images={images} index={lightbox} onIndex={setLightbox} onClose={() => setLightbox(null)} />}
    </div>
  )
}
