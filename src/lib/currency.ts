export type CalcAmountUsdInput = {
  amount: number
  currency: string
  exchangeRate?: number
}

export function calcAmountUsd({ amount, currency, exchangeRate }: CalcAmountUsdInput): number {
  if (currency === 'VND') {
    if (!exchangeRate || exchangeRate <= 0) throw new Error('exchangeRate required for VND')
    return Math.round((amount / exchangeRate) * 100) / 100
  }
  return amount
}
