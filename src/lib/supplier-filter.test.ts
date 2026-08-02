import { describe, expect, it } from 'vitest'
import { filterBySupplierId } from '@/lib/supplier-filter'

const products = [
  { id: 'mango-shirt', supplierId: 'mango' },
  { id: 'jomall-mug', supplierId: 'jomall' },
  { id: 'mango-hoodie', supplierId: 'mango' },
]

describe('filterBySupplierId', () => {
  it('returns no products until a supplier is selected', () => {
    expect(filterBySupplierId(products, '')).toEqual([])
  })

  it('returns only products owned by the selected supplier', () => {
    expect(filterBySupplierId(products, 'mango').map(product => product.id)).toEqual([
      'mango-shirt',
      'mango-hoodie',
    ])
  })
})
