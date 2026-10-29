'use client'
import Link from 'next/link'
import type { TaskDetail } from './types'
import { copyText } from './model'
import { printTemplatesUrl } from './checklist'
import { useToast } from './overlay'
import { Icon } from './ui'

const sep = <span className="text-outline-variant">·</span>
const ext = 'inline-flex items-center gap-[2px] font-medium text-secondary hover:underline'

export default function SupplierStrip({ detail }: { detail: TaskDetail }) {
  const { line, template, task, me } = detail
  const toast = useToast()

  if (!line.supplier) {
    return (
      <div className="flex flex-wrap items-center gap-x-[14px] gap-y-sm px-[20px] py-[10px] bg-error-container/50 border-t border-error-container text-body-sm text-on-error-container">
        <Icon name="factory" className="text-[18px] text-error" />
        <span className="font-semibold">Chưa map xưởng</span>
        <span>SKU <span className="font-mono">{task.sku ?? '—'}</span> chưa có xưởng{task.supplierName ? ` (trước: ${task.supplierName})` : ''}</span>
        {sep}
        <span className="font-semibold">Chưa có template</span>
        <Link href="/fulfillment/mapping" className="ml-auto inline-flex items-center gap-xs h-8 px-sm rounded-lg border border-error bg-surface-container-lowest font-semibold hover:bg-error-container/40">
          Mở Mapping<Icon name="open_in_new" className="text-[15px]" />
        </Link>
      </div>
    )
  }

  const tplLink = template?.templateUrl ?? line.templateUrl
  const zones = template ? new Set(template.areas.map(a => a.name)).size : 0
  return (
    <div className="flex flex-wrap items-center gap-x-[14px] gap-y-xs px-[20px] py-[10px] bg-surface-container-low border-t border-outline-variant/40 text-[13px] leading-[18px] text-on-surface-variant">
      <span className="inline-flex items-center gap-xs text-on-surface">
        <Icon name="factory" className="text-[18px] text-on-surface-variant" /><b>{line.supplier.name}</b><span className="text-on-surface-variant">({line.supplier.code})</span>
      </span>
      {sep}
      <span className="inline-flex items-center gap-xs">
        SKU xưởng <span className="font-mono text-on-surface">{line.supplierSku ?? '—'}</span>
        {line.supplierSku && (
          <button type="button" aria-label="Copy SKU xưởng" title="Copy SKU xưởng" className="inline-grid place-items-center w-6 h-6 rounded-md hover:bg-surface-container"
            onClick={async () => toast.say(await copyText(line.supplierSku!) ? `Đã chép "${line.supplierSku}"` : 'Không chép được')}>
            <Icon name="content_copy" className="text-[15px]" />
          </button>
        )}
        {line.supplierSku && (line.supplierProduct
          ? <span className="text-on-surface">{line.supplierProduct}</span>
          : <span className="text-amber-900" title="SKU xưởng không có trong bảng giá xưởng">không có trong bảng giá</span>)}
      </span>
      {sep}
      {template ? (
        <>
          {tplLink
            ? <a href={tplLink} target="_blank" rel="noreferrer" className={ext}>Template {template.name}<Icon name="open_in_new" className="text-[15px]" /></a>
            : <span className="text-on-surface">Template {template.name}</span>}
          <span className="font-mono text-on-surface">{template.widthPx}×{template.heightPx} px</span>
          <span>{template.dpi} DPI</span>
          <span>{zones} vùng in</span>
          {template.mirror && <span className="font-semibold text-amber-900" title="Xưởng in lật gương file này">mirror</span>}
        </>
      ) : (
        <span className="inline-flex items-center gap-xs text-amber-900">
          <Icon name="dashboard_customize" className="text-[16px]" />Chưa có template — upload file in theo yêu cầu xưởng
          {me.isLeader && <Link href={printTemplatesUrl(line.supplier.id)} className={ext}>Thêm template<Icon name="open_in_new" className="text-[15px]" /></Link>}
          {!me.isLeader && tplLink && <a href={tplLink} target="_blank" rel="noreferrer" className={ext}>Mở template<Icon name="open_in_new" className="text-[15px]" /></a>}
        </span>
      )}
      {(line.masterArtworkUrl || detail.driveFolder?.url) && sep}
      {line.masterArtworkUrl && <a href={line.masterArtworkUrl} target="_blank" rel="noreferrer" className={ext}>Master<Icon name="open_in_new" className="text-[15px]" /></a>}
      {detail.driveFolder?.url
        ? <a href={detail.driveFolder.url} target="_blank" rel="noreferrer" className={ext}>Thư mục Drive<Icon name="open_in_new" className="text-[15px]" /></a>
        : <span title={detail.driveConnected ? 'Thư mục tạo khi file đầu tiên lên Drive' : 'Drive chưa kết nối'}>Chưa có thư mục Drive</span>}
    </div>
  )
}
