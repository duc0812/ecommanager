import { describe, expect, it } from 'vitest'
import { findDriveAttachmentForLine } from '@/lib/order-line-assets'

describe('findDriveAttachmentForLine', () => {
  it('matches multi-line orders by order line key', () => {
    const attachments = [
      { name: '#LIT2352_2 - Google Drive', url: 'https://drive.google.com/folders/two' },
      { name: '#LIT2352_1 - Google Drive', url: 'https://drive.google.com/folders/one' },
    ]

    expect(findDriveAttachmentForLine('#LIT2352', 1, 'SKU-A', attachments, 2)?.url)
      .toBe('https://drive.google.com/folders/one')
    expect(findDriveAttachmentForLine('#LIT2352', 2, 'SKU-B', attachments, 2)?.url)
      .toBe('https://drive.google.com/folders/two')
  })

  it('does not guess for multiple product lines without a key match', () => {
    const attachments = [
      { name: 'Google Drive', url: 'https://drive.google.com/folders/only' },
    ]

    expect(findDriveAttachmentForLine('#LIT2352', 1, 'SKU-A', attachments, 2)).toBeNull()
  })
})
