import { createHash } from 'crypto'
import type { TemplateRow } from '@/lib/print-template-resolve'

export function templateStamp(t: TemplateRow): string {
  return createHash('sha256').update(JSON.stringify({ id: t.id, widthPx: t.widthPx, heightPx: t.heightPx, dpi: t.dpi, bleedIn: t.bleedIn, safeIn: t.safeIn, mirror: t.mirror, areas: t.areas, altSets: t.altSets, guide: t.guideImageUrl, url: t.templateUrl })).digest('hex')
}

export function sourceTemplateVersion(a: { templateSnapshot: string; templateVersion: string }): string {
  return JSON.parse(a.templateSnapshot).sourceVersion ?? a.templateVersion
}
