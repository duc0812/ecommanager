// "#REMI1010" is REMI. The tool tells which store an order belongs to by the letters right before the number
// (sheet rows are routed the same way by storeForOrderName), so "#REMI-1010" and "#1001" have no prefix.
export function orderPrefixOf(name: string | null | undefined): string | null {
  const letters = name?.trim().match(/^#?([A-Za-z]+)\d/)?.[1]
  return letters ? letters.toUpperCase() : null
}

export function storesWithPrefix<S extends { orderPrefix: string | null }>(prefix: string | null, stores: S[]): S[] {
  return prefix ? stores.filter(s => s.orderPrefix?.trim().toUpperCase() === prefix) : []
}

// The one store whose orderPrefix the order name carries. A name with no prefix, a prefix no store has, and a prefix
// two stores claim all give null: an order is never guessed onto a store.
export function storeForOrderName<S extends { orderPrefix: string | null }>(name: string, stores: S[]): S | null {
  const matches = storesWithPrefix(orderPrefixOf(name), stores)
  return matches.length === 1 ? matches[0] : null
}
