// Maps a last-mile tracking number to a Shopify tracking company (so Shopify
// builds a clickable, correct tracking URL) plus a fallback URL for carriers
// Shopify doesn't natively recognise. Company names must match Shopify's
// supported-carriers list exactly for auto-URL generation.

export type LastMileCarrier = { company: string; url?: string }

const parcelsappUrl = (n: string) => `https://parcelsapp.com/en/tracking/${encodeURIComponent(n)}`

export function detectLastMileCarrier(rawNumber: string): LastMileCarrier {
  const n = rawNumber.trim().toUpperCase()

  // USPS domestic IMpb: 22-digit starting with 9, 420+ZIP routing, or 9261/92612903 prefixes.
  if (/^9\d{19,25}$/.test(n) || /^420\d{4,}9\d{10,}$/.test(n) || /^92\d{18,}$/.test(n)) return { company: 'USPS' }
  // China Post S10 (LZ...CN) — USPS accepts and delivers/scans these directly.
  if (/^LZ\w+CN$/.test(n)) return { company: 'USPS' }
  if (/^4PX/.test(n)) return { company: '4PX' }
  if (/^YW/.test(n)) return { company: 'Yanwen' }
  if (/^JJD/.test(n)) return { company: 'DHL eCommerce' }
  if (/^SF\d/.test(n)) return { company: 'SF Express' }

  // Carriers Shopify doesn't build URLs for: keep a readable label + a working link.
  if (/^SPX/.test(n)) return { company: 'Shopee Xpress', url: parcelsappUrl(rawNumber) }
  if (/^GFUS/.test(n)) return { company: 'GoFo Express', url: parcelsappUrl(rawNumber) }
  if (/^UUS/.test(n)) return { company: 'UniUni', url: parcelsappUrl(rawNumber) }
  if (/^EM\w+CA$/.test(n)) return { company: 'Canada Post', url: parcelsappUrl(rawNumber) }
  return { company: 'Other', url: parcelsappUrl(rawNumber) }
}
