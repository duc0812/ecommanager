export function isLayerlessField(key: string): boolean {
  return /size|yes or no/i.test(key)
}
