import { describe, it, expect } from 'vitest'
import { calcAmountUsd } from './currency'

describe('calcAmountUsd', () => {
  it('returns amount unchanged for USD', () => {
    expect(calcAmountUsd({ amount: 29.99, currency: 'USD' })).toBe(29.99)
  })

  it('converts VND to USD using exchange rate', () => {
    expect(calcAmountUsd({ amount: 254000, currency: 'VND', exchangeRate: 25400 })).toBe(10)
  })

  it('rounds VND conversion to 2 decimal places', () => {
    expect(calcAmountUsd({ amount: 100000, currency: 'VND', exchangeRate: 25400 })).toBe(3.94)
  })

  it('throws if currency is VND and exchangeRate is missing', () => {
    expect(() => calcAmountUsd({ amount: 100000, currency: 'VND' })).toThrow('exchangeRate required')
  })

  it('throws if currency is VND and exchangeRate is zero', () => {
    expect(() => calcAmountUsd({ amount: 100000, currency: 'VND', exchangeRate: 0 })).toThrow('exchangeRate required')
  })
})
