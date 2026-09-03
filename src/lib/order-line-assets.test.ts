import { describe, it, expect } from 'vitest'
import { findDriveAttachmentForSku } from './order-line-assets'

const att = (name: string) => ({ name, url: 'https://drive.google.com/file/d/' + name })

describe('findDriveAttachmentForSku', () => {
  it('matches the file whose name contains the sku', () => {
    const files = [att('DN1-11OZ'), att('DN1-15OZ')]
    expect(findDriveAttachmentForSku('DN1-15OZ', files)?.name).toBe('DN1-15OZ')
  })

  it('is case-insensitive', () => {
    expect(findDriveAttachmentForSku('dn1-15oz', [att('DN1-15OZ')])?.name).toBe('DN1-15OZ')
  })

  it('returns null when no file matches', () => {
    expect(findDriveAttachmentForSku('ZZZ', [att('DN1-15OZ')])).toBeNull()
  })

  it('returns null for empty sku', () => {
    expect(findDriveAttachmentForSku('', [att('DN1-15OZ')])).toBeNull()
  })
})
