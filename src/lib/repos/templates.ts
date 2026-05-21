import { prisma } from '@/lib/db'

export type TemplateColumn = { header: string; source: string }

export const STANDARD_SUPPLIER_EXPORT_COLUMNS: TemplateColumn[] = [
  { header: 'Date', source: 'order.placedDate' },
  { header: 'Order Number', source: 'order.shopifyOrderNumber' },
  { header: 'Order Vendor', source: 'line.lineKey' },
  { header: 'Customer Note', source: 'literal:' },
  { header: 'Phone (Billing)', source: 'order.shippingPhone' },
  { header: 'Name (Shipping)', source: 'order.shippingName' },
  { header: 'Address 1&2 (Shipping)', source: 'order.shippingAddressFull' },
  { header: 'City (Shipping)', source: 'order.shippingCity' },
  { header: 'State Code (Shipping)', source: 'order.shippingState' },
  { header: 'Postcode Code (Shipping)', source: 'order.shippingZip' },
  { header: 'Country Code (Shipping)', source: 'order.shippingCountry' },
  { header: 'SKU Suplier', source: 'line.supplierBaseSku' },
  { header: 'SKU Custom', source: 'line.sku' },
  { header: 'Item Name', source: 'line.itemName' },
  { header: 'Type', source: 'line.supplierProductName' },
  { header: 'Size', source: 'line.supplierVariant1Value' },
  { header: 'Color', source: 'line.supplierVariant2Value' },
  { header: 'SKU COLOR', source: 'literal:' },
  { header: 'Design Note', source: 'literal:' },
  { header: 'Quantity', source: 'line.qty' },
  { header: 'mockup link', source: 'line.previewCdnUrl' },
  { header: 'design link', source: 'line.designDriveLink' },
  { header: 'Input Fields', source: 'literal:' },
  { header: 'Fee Shipping', source: 'literal:' },
  { header: 'note track', source: 'literal:' },
  { header: 'Tracking', source: 'literal:' },
  { header: 'NEW Tracking', source: 'literal:' },
  { header: 'x', source: 'literal:' },
]

export type CreateTemplateInput = {
  supplierId: string
  name: string
  columns: TemplateColumn[]
  rowMode: 'PER_LINE' | 'PER_ORDER'
  isDefault?: boolean
}

export async function listTemplates(supplierId?: string) {
  return prisma.csvTemplate.findMany({
    where: supplierId ? { supplierId } : {},
    orderBy: [{ supplierId: 'asc' }, { createdAt: 'asc' }],
    include: { supplier: { select: { id: true, name: true, code: true } } },
  })
}

export async function ensureStandardSupplierTemplate(supplierId: string) {
  const existingDefault = await prisma.csvTemplate.findFirst({
    where: { supplierId, isDefault: true },
    include: { supplier: { select: { id: true, name: true, code: true } } },
  })
  if (existingDefault) return existingDefault

  const existingAny = await prisma.csvTemplate.findFirst({
    where: { supplierId },
    orderBy: { createdAt: 'asc' },
    include: { supplier: { select: { id: true, name: true, code: true } } },
  })
  if (existingAny) return existingAny

  return prisma.csvTemplate.create({
    data: {
      supplierId,
      name: 'Standard Supplier Fulfillment Export',
      rowMode: 'PER_LINE',
      isDefault: true,
      columns: JSON.stringify(STANDARD_SUPPLIER_EXPORT_COLUMNS),
    },
    include: { supplier: { select: { id: true, name: true, code: true } } },
  })
}

export async function getTemplateById(id: string) {
  return prisma.csvTemplate.findUnique({
    where: { id },
    include: { supplier: { select: { id: true, name: true, code: true } } },
  })
}

export async function createTemplate(input: CreateTemplateInput) {
  return prisma.$transaction(async (tx) => {
    if (input.isDefault) {
      await tx.csvTemplate.updateMany({
        where: { supplierId: input.supplierId, isDefault: true },
        data: { isDefault: false },
      })
    }
    return tx.csvTemplate.create({
      data: {
        supplierId: input.supplierId,
        name: input.name,
        columns: JSON.stringify(input.columns),
        rowMode: input.rowMode,
        isDefault: input.isDefault ?? false,
      },
    })
  })
}

export type UpdateTemplateInput = Partial<Omit<CreateTemplateInput, 'supplierId'>>

export async function updateTemplate(id: string, input: UpdateTemplateInput) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.csvTemplate.findUnique({ where: { id } })
    if (!existing) throw new Error('Template not found')
    if (input.isDefault) {
      await tx.csvTemplate.updateMany({
        where: { supplierId: existing.supplierId, isDefault: true, NOT: { id } },
        data: { isDefault: false },
      })
    }
    return tx.csvTemplate.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.columns !== undefined ? { columns: JSON.stringify(input.columns) } : {}),
        ...(input.rowMode !== undefined ? { rowMode: input.rowMode } : {}),
        ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
      },
    })
  })
}

export async function deleteTemplate(id: string) {
  return prisma.csvTemplate.delete({ where: { id } })
}

export function parseTemplateColumns(jsonStr: string): TemplateColumn[] {
  try {
    const arr = JSON.parse(jsonStr)
    if (!Array.isArray(arr)) return []
    return arr.filter(c => c && typeof c.header === 'string' && typeof c.source === 'string')
  } catch {
    return []
  }
}
