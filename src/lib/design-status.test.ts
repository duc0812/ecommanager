import { describe, it, expect } from 'vitest'
import { lineDesignStatus } from './design-status'

const base = { isNonProduct: false, previewCdnUrl: null, designDriveLink: null, hasLibraryDesign: false }

describe('lineDesignStatus', () => {
  it('customized line with design link → DONE', () => {
    expect(lineDesignStatus({ ...base, previewCdnUrl: 'http://p', designDriveLink: 'http://d' })).toBe('DONE')
  })

  it('customized line without design link → PENDING', () => {
    expect(lineDesignStatus({ ...base, previewCdnUrl: 'http://p' })).toBe('PENDING')
  })

  it('not customized but has a ready Design Library entry → LIBRARY', () => {
    expect(lineDesignStatus({ ...base, hasLibraryDesign: true })).toBe('LIBRARY')
  })

  it('customized takes precedence over a library entry', () => {
    expect(lineDesignStatus({ ...base, previewCdnUrl: 'http://p', hasLibraryDesign: true })).toBe('PENDING')
  })

  it('nothing → NONE', () => {
    expect(lineDesignStatus(base)).toBe('NONE')
  })

  it('non-product (digital add-on) line → NONE regardless', () => {
    expect(lineDesignStatus({ ...base, isNonProduct: true, previewCdnUrl: 'http://p', hasLibraryDesign: true })).toBe('NONE')
  })
})
