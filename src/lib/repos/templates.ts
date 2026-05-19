import { prisma } from '@/lib/db'

export type TemplateColumn = { header: string; source: string }

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
