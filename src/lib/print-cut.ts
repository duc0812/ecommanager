import { currentFiles, sameLabel } from '@/lib/task-files'

export const PRINT_CUT_SIZING = 'MATCH_PRINT_CUT' as const
export const TOPPER_PRINT_CUT_ID = 'preset:go-3d-topper-print-cut'
export const TOPPER_SUPPLIER_CODE = '3'

export function isTopperProductType(productType: string | null | undefined): boolean {
  return ['topper', 'tree topper', 'acrylic tree topper'].includes((productType ?? '').trim().replace(/\s+/g, ' ').toLowerCase())
}

export function topperPrintCutTemplate(productType: string | null | undefined, supplierCode?: string | null) {
  if (!isTopperProductType(productType) || (supplierCode !== undefined && supplierCode !== TOPPER_SUPPLIER_CODE)) return null
  return {
    id: TOPPER_PRINT_CUT_ID, name: 'Gỗ 3D VN Topper — file in / file cắt', widthPx: 2000, heightPx: 1000,
    dpi: 300, bleedIn: 0, safeIn: 0, mirror: false,
    // These boxes only lay out the editor; uploaded files have no prescribed print size.
    areas: ['Print', 'Cut'].map((name, i) => ({ name, x: i * 1000, y: 0, w: 1000, h: 1000, sizing: PRINT_CUT_SIZING })),
    guideImageUrl: null, templateUrl: null, altSets: [], areaSet: null,
  }
}
type PairTemplate = { areas: { name: string; sizing?: string }[] }
type PairFile = {
  kind?: string | null; printArea: string; version: number; createdAt?: Date | string | null
  widthPx: number | null; heightPx: number | null; removedAt?: Date | string | null
}

export function isPrintCutTemplate(template: PairTemplate | null | undefined): boolean {
  return template?.areas.length === 2 && template.areas.every(a => a.sizing === PRINT_CUT_SIZING)
}

export function printCutCheck(template: PairTemplate | null | undefined, files: PairFile[]): { ok: boolean; message: string } | null {
  if (!template || !isPrintCutTemplate(template)) return null
  const current = currentFiles(files.filter(f => !f.removedAt), 'PRINT')
  const pair = template.areas.map(a => current.find(f => sameLabel(f.printArea, a.name)))
  const missing = template.areas.filter((_a, i) => !pair[i]).map(a => a.name)
  if (missing.length) return { ok: false, message: `Thiếu file: ${missing.join(', ')}` }
  const [print, cut] = pair as PairFile[]
  if (![print.widthPx, print.heightPx, cut.widthPx, cut.heightPx].every(n => typeof n === 'number' && Number.isFinite(n) && n > 0)) {
    return { ok: false, message: 'Chưa đọc được kích thước hai file in/cắt — dùng PNG/JPG để đối chiếu' }
  }
  if (print.widthPx !== cut.widthPx || print.heightPx !== cut.heightPx) {
    return { ok: false, message: `File in/cắt lệch khổ: ${print.widthPx}×${print.heightPx} và ${cut.widthPx}×${cut.heightPx} px` }
  }
  return { ok: true, message: `Hai file cùng khổ ${print.widthPx}×${print.heightPx} px — chồng ảnh để soi đường cắt` }
}
