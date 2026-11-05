import { describe, expect, it } from 'vitest'
import { choiceFor, withStoreQuery } from './use-store-filter'

const TWO = [{ id: 's1' }, { id: 's2' }]

describe('choiceFor', () => {
  it('keeps a saved choice that is still one of the stores', () => {
    expect(choiceFor('s2', TWO)).toBe('s2')
  })

  it('drops a saved choice that is not one of the stores (another user\'s store, or one that was taken away)', () => {
    expect(choiceFor('s9', TWO)).toBeNull()
    expect(choiceFor('s1', [{ id: 's2' }, { id: 's3' }])).toBeNull()
  })

  it('has no choice when nothing was saved', () => {
    expect(choiceFor(null, TWO)).toBeNull()
    expect(choiceFor('', TWO)).toBeNull()
  })

  it('has no choice for a user with one store or none, whatever was saved', () => {
    expect(choiceFor('s1', [{ id: 's1' }])).toBeNull()
    expect(choiceFor('s1', [])).toBeNull()
  })
})

describe('withStoreQuery', () => {
  it('adds the query to a url with or without parameters, and leaves a url alone when there is none', () => {
    expect(withStoreQuery('/api/overview', 'storeId=s1')).toBe('/api/overview?storeId=s1')
    expect(withStoreQuery('/api/overview?period=all', 'storeId=s1')).toBe('/api/overview?period=all&storeId=s1')
    expect(withStoreQuery('/api/overview?period=all', '')).toBe('/api/overview?period=all')
  })
})
