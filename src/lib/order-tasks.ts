import { isNonProductLine } from '@/lib/order-lines'

// "Task Need Fix": data-state issues on active orders that a team must resolve.
// Detection is pure (computed from current order data); crons/sync handle the
// downstream resolution logic — a task simply reflects the current data state.

export type TaskDept = 'MAPPING' | 'DESIGN'
export type TaskType = 'MISSING_SKU' | 'UNMAPPED' | 'MISSING_BASE_COST' | 'MISSING_DESIGN'

export const TASK_TYPES: TaskType[] = ['MISSING_SKU', 'UNMAPPED', 'MISSING_BASE_COST', 'MISSING_DESIGN']

export const TASK_META: Record<TaskType, { dept: TaskDept; label: string }> = {
  MISSING_SKU: { dept: 'MAPPING', label: 'Thiếu SKU' },
  UNMAPPED: { dept: 'MAPPING', label: 'Chưa mapping' },
  MISSING_BASE_COST: { dept: 'MAPPING', label: 'Thiếu base cost' },
  MISSING_DESIGN: { dept: 'DESIGN', label: 'Thiếu design' },
}

export type TaskLine = {
  sku: string | null
  productTitle: string
  shopifyProductType?: string | null
  resolvedSupplierId: string | null
  resolvedBaseCost: number | null
  manualBaseCost: number | null
}

export type TaskOrderInput = {
  orderType: string
  designReady: boolean
  lines: TaskLine[]
}

export type OrderTask = { type: TaskType; dept: TaskDept; label: string; detail: string }

export function detectOrderTasks(o: TaskOrderInput): OrderTask[] {
  const product = o.lines.filter(l => !isNonProductLine({
    sku: l.sku, productTitle: l.productTitle, shopifyProductType: l.shopifyProductType,
  }))
  const tasks: OrderTask[] = []
  const add = (type: TaskType, detail: string) =>
    tasks.push({ type, dept: TASK_META[type].dept, label: TASK_META[type].label, detail })

  const missingSku = product.filter(l => !l.sku || !l.sku.trim())
  if (missingSku.length) add('MISSING_SKU', missingSku.map(l => l.productTitle).join(', '))

  const unmapped = product.filter(l => l.sku && l.sku.trim() && !l.resolvedSupplierId)
  if (unmapped.length) add('UNMAPPED', unmapped.map(l => l.sku).join(', '))

  const noCost = product.filter(l => l.resolvedSupplierId && l.resolvedBaseCost == null && l.manualBaseCost == null)
  if (noCost.length) add('MISSING_BASE_COST', noCost.map(l => l.sku ?? l.productTitle).join(', '))

  if (o.orderType === 'NON_CUSTOM' && !o.designReady) add('MISSING_DESIGN', 'Đơn non-custom chưa có design')

  return tasks
}
