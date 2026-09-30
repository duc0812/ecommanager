// Card details Meta returns in `funding_source_details` / billing activity extra data.
// Shared by the billing sync and the reserve sync so both read a card the same way.
export function parseLast4(value: unknown): string | null {
  if (value == null) return null
  if (typeof value === 'object') {
    const details = value as Record<string, unknown>
    const direct = details.last4 ?? details.last_4 ?? details.card_last_four_digits
    if (direct) return String(direct).slice(-4)
  }

  const text = typeof value === 'string' ? value : JSON.stringify(value)
  const match = text.match(/(?:\*+|x+|\.{2,}|[-\s])(\d{4})(?!\d)/i)
  return match?.[1] ?? null
}

export function cleanPaymentMethodLabel(value: string | null) {
  if (!value) return null
  return value.replace(/\s*(?:\*+|x+|\.{2,}|[-\s])\d{4}\s*$/i, '').trim() || value
}
