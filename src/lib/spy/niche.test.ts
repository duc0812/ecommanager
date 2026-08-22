import { describe, it, expect } from 'vitest'
import { parseKeywords, nicheMatches, nicheOrWhere } from './niche'

describe('niche helpers', () => {
  it('parseKeywords parses arrays and drops empties', () => {
    expect(parseKeywords('["dsny"," disney ",""]')).toEqual(['dsny', 'disney'])
    expect(parseKeywords(null)).toEqual([])
    expect(parseKeywords('not json')).toEqual([])
    expect(parseKeywords('{"a":1}')).toEqual([])
  })
  it('nicheMatches is case-insensitive substring, any keyword', () => {
    expect(nicheMatches('DISNEY Mug 100th', ['disney'])).toBe(true)
    expect(nicheMatches('Jeep Shirt', ['disney', 'jeep'])).toBe(true)
    expect(nicheMatches('Pokemon Tee', ['disney'])).toBe(false)
    expect(nicheMatches(null, ['x'])).toBe(false)
    expect(nicheMatches('x', [])).toBe(false)
  })
  it('nicheOrWhere builds OR across keywords x fields; undefined when empty', () => {
    expect(nicheOrWhere(['dsny'], ['title', 'body'])).toEqual({
      OR: [{ title: { contains: 'dsny' } }, { body: { contains: 'dsny' } }],
    })
    expect(nicheOrWhere([], ['title'])).toBeUndefined()
    expect(nicheOrWhere(['x'], [])).toBeUndefined()
  })
})
