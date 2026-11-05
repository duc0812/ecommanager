// "#REMI1010" is REMI. The tool tells which store an order belongs to by the letters right before the number
// (sheet rows are routed the same way in orderNameHasPrefix), so "#REMI-1010" and "#1001" have no prefix.
export function orderPrefixOf(name: string | null | undefined): string | null {
  const letters = name?.trim().match(/^#?([A-Za-z]+)\d/)?.[1]
  return letters ? letters.toUpperCase() : null
}
