import { describe, expect, it } from 'vitest'
import { SETUP_BLOCKS, blockFromSearch } from '@/lib/setup-blocks'

describe('blockFromSearch', () => {
  it('opens Store by default, and the asked block', () => {
    expect(blockFromSearch('')).toBe('store')
    expect(blockFromSearch('?block=marketing')).toBe('marketing')
  })

  it('ignores a block that does not exist', () => {
    expect(blockFromSearch('?block=nope')).toBe('store')
  })

  it('returns from Google to the card that started it', () => {
    expect(blockFromSearch('?sheets=connected')).toBe('fulfill')
    expect(blockFromSearch('?sheets=error&reason=no_sheets_scope')).toBe('fulfill')
    expect(blockFromSearch('?google=connected')).toBe('design')
  })

  it('keeps the sidebar pages reachable from one block each', () => {
    const hrefs = SETUP_BLOCKS.flatMap(b => b.links.map(l => l.href))
    for (const href of ['/setup/meta', '/setup/meta-rates', '/setup/projects', '/setup/hr', '/setup/users']) {
      expect(hrefs.filter(h => h === href)).toHaveLength(1)
    }
  })
})
