export function filterBySupplierId<T extends { supplierId: string }>(
  items: T[],
  supplierId: string,
): T[] {
  if (!supplierId) return []
  return items.filter(item => item.supplierId === supplierId)
}
