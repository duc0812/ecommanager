export const REGIONS = ['US', 'EU', 'GB', 'CA', 'ROW'] as const
export type Region = typeof REGIONS[number]

export const DEFAULT_ZONE_COUNTRIES: Record<Region, string[]> = {
  US: ['US'],
  EU: [
    'AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT',
    'LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE',
  ],
  GB: ['GB', 'UK'],
  CA: ['CA'],
  ROW: [],
}

export type SupplierZoneOverrides = Record<string, string[]>

export function resolveZone(
  countryCode: string | null | undefined,
  overrides?: SupplierZoneOverrides,
): Region | string {
  if (!countryCode) return 'ROW'
  const cc = countryCode.toUpperCase()

  // Per-supplier override has priority
  if (overrides) {
    for (const [zone, codes] of Object.entries(overrides)) {
      if (codes.map(c => c.toUpperCase()).includes(cc)) return zone
    }
  }

  // Default mapping (excluding ROW which is catch-all)
  for (const z of REGIONS) {
    if (z === 'ROW') continue
    if (DEFAULT_ZONE_COUNTRIES[z].includes(cc)) return z
  }
  return 'ROW'
}
