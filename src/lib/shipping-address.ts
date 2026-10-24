const US_STATES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT',
  delaware: 'DE', 'district of columbia': 'DC', 'washington dc': 'DC', 'washington d.c.': 'DC', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA',
  maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO',
  montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM',
  'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
  pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX',
  utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
  'puerto rico': 'PR', guam: 'GU', 'american samoa': 'AS', 'northern mariana islands': 'MP',
  'virgin islands': 'VI', 'u.s. virgin islands': 'VI', 'us virgin islands': 'VI',
  'armed forces americas': 'AA', 'armed forces europe': 'AE', 'armed forces pacific': 'AP',
}

const CA_PROVINCES: Record<string, string> = {
  alberta: 'AB', 'british columbia': 'BC', manitoba: 'MB', 'new brunswick': 'NB',
  'newfoundland and labrador': 'NL', newfoundland: 'NL', 'northwest territories': 'NT', 'nova scotia': 'NS',
  nunavut: 'NU', ontario: 'ON', 'prince edward island': 'PE', quebec: 'QC', saskatchewan: 'SK', yukon: 'YT',
}

const COUNTRY_NAMES: Record<string, string> = {
  US: 'United States', CA: 'Canada', GB: 'United Kingdom', AU: 'Australia', NZ: 'New Zealand', IE: 'Ireland',
  DE: 'Germany', FR: 'France', IT: 'Italy', ES: 'Spain', PT: 'Portugal', NL: 'Netherlands', BE: 'Belgium',
  LU: 'Luxembourg', AT: 'Austria', CH: 'Switzerland', SE: 'Sweden', NO: 'Norway', DK: 'Denmark', FI: 'Finland',
  IS: 'Iceland', PL: 'Poland', CZ: 'Czechia', SK: 'Slovakia', HU: 'Hungary', RO: 'Romania', BG: 'Bulgaria',
  GR: 'Greece', HR: 'Croatia', SI: 'Slovenia', EE: 'Estonia', LV: 'Latvia', LT: 'Lithuania', MT: 'Malta', CY: 'Cyprus',
  MX: 'Mexico', BR: 'Brazil', AR: 'Argentina', CL: 'Chile', CO: 'Colombia', PE: 'Peru',
  JP: 'Japan', KR: 'South Korea', CN: 'China', HK: 'Hong Kong', TW: 'Taiwan', SG: 'Singapore', MY: 'Malaysia',
  TH: 'Thailand', VN: 'Vietnam', PH: 'Philippines', ID: 'Indonesia', IN: 'India',
  AE: 'United Arab Emirates', SA: 'Saudi Arabia', IL: 'Israel', TR: 'Turkey', ZA: 'South Africa',
}

const COUNTRY_ALIASES: Record<string, string> = {
  usa: 'US', 'united states of america': 'US', uk: 'GB', 'great britain': 'GB', 'czech republic': 'CZ', korea: 'KR', 'viet nam': 'VN',
}

function normalize(value: string | null | undefined): string {
  return (value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase().replace(/\s+/g, ' ')
}

export function splitPersonName(full: string | null | undefined): { first: string; last: string } {
  const words = (full ?? '').trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return { first: '', last: '' }
  if (words.length === 1) return { first: words[0], last: words[0] }
  return { first: words.slice(0, -1).join(' '), last: words[words.length - 1] }
}

export function countryCodeOf(value: string | null | undefined): string | null {
  const raw = (value ?? '').trim()
  if (!raw) return null
  if (/^[A-Za-z]{2}$/.test(raw)) return raw.toUpperCase()
  const key = normalize(raw)
  if (COUNTRY_ALIASES[key]) return COUNTRY_ALIASES[key]
  const hit = Object.entries(COUNTRY_NAMES).find(([, name]) => normalize(name) === key)
  return hit ? hit[0] : null
}

export function countryNameOf(code: string | null | undefined): string {
  const c = (code ?? '').trim().toUpperCase()
  return COUNTRY_NAMES[c] ?? c
}

/** 2-letter state/province code from its full name for US and CA; null when the country has no table or the name is unknown. */
export function stateCodeFromName(countryCode: string | null | undefined, state: string | null | undefined): string | null {
  const country = (countryCode ?? '').trim().toUpperCase()
  const raw = (state ?? '').trim()
  if (!raw) return null
  const table = country === 'US' ? US_STATES : country === 'CA' ? CA_PROVINCES : null
  if (!table) return null
  if (/^[A-Za-z]{2}$/.test(raw)) {
    const upper = raw.toUpperCase()
    return Object.values(table).includes(upper) ? upper : null
  }
  return table[normalize(raw)] ?? null
}

export function resolveStateCode(input: { countryCode: string | null; stateCode: string | null | undefined; state: string | null | undefined }): string | null {
  const stored = (input.stateCode ?? '').trim()
  if (stored) return stored.toUpperCase()
  return stateCodeFromName(input.countryCode, input.state)
}

export const PGPRINTS_ADDRESS_LINE_MAX = 32

/**
 * PGprints refuses an address1 longer than 32 characters. The overflow moves to the front of address2,
 * cut at the last space that still fits (or hard at the limit when there is none).
 */
export function splitAddressLine(address1: string, address2: string, max = PGPRINTS_ADDRESS_LINE_MAX): { address1: string; address2: string; split: boolean } {
  const a1 = address1.trim()
  const a2 = address2.trim()
  if (a1.length <= max) return { address1: a1, address2: a2, split: false }
  const cut = a1.lastIndexOf(' ', max)
  const at = cut > 0 ? cut : max
  const head = a1.slice(0, at).trim()
  const tail = a1.slice(at).trim()
  return { address1: head, address2: [tail, a2].filter(Boolean).join(', '), split: true }
}
