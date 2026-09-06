'use client'
import { useState } from 'react'
import type { CampaignRow } from '@/lib/marketing/niche-performance'
import { fmtUsd, fmtMoney, fmtPct, fmtInt, fmtDate } from './format'

type Props = {
  campaigns: CampaignRow[]
  niches?: Array<{ id: string; name: string }>
  onAssign?: (campaignId: string, nicheId: string) => Promise<void>
}

export default function CampaignTable({ campaigns, niches, onAssign }: Props) {
  const [busy, setBusy] = useState<string | null>(null)
  const canAssign = Boolean(niches && onAssign)

  if (campaigns.length === 0) {
    return <p className="px-lg py-md text-body-sm text-on-surface-variant">Không có campaign nào trong kỳ này.</p>
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-body-sm">
        <thead>
          <tr className="text-label-sm text-on-surface-variant uppercase tracking-wider border-b border-outline-variant/20">
            <th className="text-left px-lg py-sm font-medium">Campaign</th>
            <th className="text-left px-md py-sm font-medium">Account</th>
            <th className="text-right px-md py-sm font-medium">Spend</th>
            <th className="text-right px-md py-sm font-medium">Impr.</th>
            <th className="text-right px-md py-sm font-medium">Clicks</th>
            <th className="text-right px-md py-sm font-medium">CPM</th>
            <th className="text-right px-md py-sm font-medium">CTR</th>
            <th className="text-left px-md py-sm font-medium">Last active</th>
            {canAssign && <th className="text-left px-md py-sm font-medium">Niche</th>}
          </tr>
        </thead>
        <tbody>
          {campaigns.map(c => (
            <tr key={c.campaignId} className="border-b border-outline-variant/10 last:border-0">
              <td className="px-lg py-sm">
                <div className="flex items-center gap-xs">
                  <span className={`inline-block w-2 h-2 rounded-full ${c.isActive ? 'bg-emerald-500' : 'bg-on-surface-variant/30'}`} />
                  <span className="text-on-surface">{c.campaignName}</span>
                </div>
              </td>
              <td className="px-md py-sm text-on-surface-variant">{c.accountName ?? c.accountId}</td>
              <td className="px-md py-sm text-right">
                <div className="text-on-surface">{fmtUsd(c.spend)}</div>
                {c.currency !== 'USD' && <div className="text-label-sm text-on-surface-variant">{fmtMoney(c.spendOriginal, c.currency)}</div>}
              </td>
              <td className="px-md py-sm text-right text-on-surface-variant">{fmtInt(c.impressions)}</td>
              <td className="px-md py-sm text-right text-on-surface-variant">{fmtInt(c.clicks)}</td>
              <td className="px-md py-sm text-right text-on-surface-variant">{c.cpm == null ? '—' : fmtUsd(c.cpm)}</td>
              <td className="px-md py-sm text-right text-on-surface-variant">{fmtPct(c.ctr)}</td>
              <td className="px-md py-sm text-on-surface-variant">{fmtDate(c.lastActiveDate)}</td>
              {canAssign && (
                <td className="px-md py-sm">
                  <select
                    defaultValue=""
                    disabled={busy === c.campaignId}
                    onChange={async e => {
                      const nicheId = e.target.value
                      if (!nicheId) return
                      setBusy(c.campaignId)
                      try { await onAssign!(c.campaignId, nicheId) } finally { setBusy(null) }
                    }}
                    className="rounded-lg border border-outline-variant/30 bg-surface-container px-sm py-xs text-body-sm"
                  >
                    <option value="">Gán niche…</option>
                    {niches!.map(n => <option key={n.id} value={n.id}>{n.name}</option>)}
                  </select>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
