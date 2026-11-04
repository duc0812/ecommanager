/** Which custom fields hold text to print. Keys are free-form, so this is a rule tried on 622 rows the team typed in Jomall's sheet. */
const PRINTED_KEY = /name|text|number|initial|personal|\bno\.?\b/i
const NOT_PRINTED_KEY = /yes\s*(or|\/)\s*no|choose|colou?r|design|image|layer|size|style|upload|photo/i
const NOT_PRINTED_VALUE = /^(yes|no|none|n\/?a)$|^download\b|^image \d|^option \d|^https?:/i

/** The text the customer wants printed: "Salty Daze", or "Lake / Lake / 21" on a jersey. A picture choice or a yes/no is not text to print. */
export function customNameOf(fields: { key: string; value: string }[]): string {
  return fields
    .filter(f => PRINTED_KEY.test(f.key) && !NOT_PRINTED_KEY.test(f.key))
    .map(f => String(f.value ?? '').trim())
    .filter(v => v && !NOT_PRINTED_VALUE.test(v))
    .join(' / ')
}
