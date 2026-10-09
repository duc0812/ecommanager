'use client'
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import Sidebar from '@/components/Sidebar'
import { useCurrentUser } from '@/components/RoleGate'
import type { TemplateListRow } from '../../components/types'
import { productUrl, requestJson } from '../../components/model'
import { ErrorBanner, Icon } from '../../components/ui'
import type { ProductDetail } from '../components/types'
import ProfileEditor from '../components/ProfileEditor'

export default function ProductProfilePage() {
  const params = useParams<{ key: string }>()
  const key = decodeURIComponent(params.key)
  const { user } = useCurrentUser()
  const canEdit = user?.role === 'SUPERADMIN' || user?.role === 'ADMIN'
  const [detail, setDetail] = useState<ProductDetail | null>(null)
  const [templates, setTemplates] = useState<TemplateListRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    const [p, t] = await Promise.all([
      requestJson<ProductDetail>(productUrl(key)),
      requestJson<{ templates: TemplateListRow[] }>('/api/design-studio/templates'),
    ])
    setLoading(false)
    if (!p.ok) { setError(p.error); return null }
    if (!t.ok) setError(`Không tải được template: ${t.error}`)
    else { setTemplates(t.data.templates); setError('') }
    setDetail(p.data)
    return p.data
  }, [key])

  useEffect(() => { void load() }, [load])

  return (
    <div className="flex min-h-screen bg-surface">
      <Sidebar />
      <main className="ml-[280px] flex-1 p-xl flex flex-col gap-md">
        <div className="flex items-center gap-sm flex-wrap">
          <Link href="/design-studio/products" className="inline-flex items-center gap-xs text-label-md text-secondary hover:underline">
            <Icon name="arrow_back" className="text-[18px]" />Sản phẩm
          </Link>
          <span className="text-on-surface-variant">/</span>
          <h1 className="text-headline-sm font-bold text-primary truncate">{detail?.summary.title || 'Hồ sơ sản phẩm'}</h1>
        </div>
        <ErrorBanner msg={error} onClose={() => setError('')} />
        {loading && <p className="text-body-sm text-on-surface-variant">Đang tải…</p>}
        {detail && <ProfileEditor key={detail.key} detail={detail} templates={templates} canEdit={canEdit} onSaved={load} />}
      </main>
    </div>
  )
}
