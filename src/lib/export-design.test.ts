import { describe, it, expect } from 'vitest'
import { pickExportDesignLink } from './export-design'

const inp = (o: Partial<Parameters<typeof pickExportDesignLink>[0]>) => ({
  lineDesignLink: null, orderDesignLink: null, productLineCount: 1,
  orderType: 'NON_CUSTOM', sku: 'S', skuDesignLink: null, ...o,
})

describe('pickExportDesignLink', () => {
  it('prefers the line link', () => {
    expect(pickExportDesignLink(inp({ lineDesignLink: 'L', orderDesignLink: 'O' }))).toBe('L')
  })
  it('uses order link for multi-line when line lacks its own', () => {
    expect(pickExportDesignLink(inp({ orderDesignLink: 'O', productLineCount: 3 }))).toBe('O')
  })
  it('falls back to SkuDesign for NON_CUSTOM', () => {
    expect(pickExportDesignLink(inp({ skuDesignLink: 'M' }))).toBe('M')
  })
  it('does not use SkuDesign for CUSTOM', () => {
    expect(pickExportDesignLink(inp({ orderType: 'CUSTOM', skuDesignLink: 'M' }))).toBeNull()
  })
})
