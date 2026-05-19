import { describe, it, expect } from 'vitest'
import { renderCsv, type CsvTemplate, type OrderForCsv } from '@/lib/csv-template'

const sampleOrder: OrderForCsv = {
  shopifyOrderNumber: '#1023',
  customerName: 'David Olsen',
  customerEmail: 'd@x.com',
  shippingCountry: 'US',
  shippingState: 'CA',
  placedAt: new Date('2026-05-18T07:06:00Z'),
  lines: [
    { sku: 'TSHIRT-RED-M', qty: 2, productTitle: 'Tee', variantTitle: 'Red / M' },
    { sku: 'HOODIE-BLK-L', qty: 1, productTitle: 'Hoodie', variantTitle: 'Black / L' },
  ],
}

describe('renderCsv', () => {
  it('renders PER_LINE rows with one row per line item', () => {
    const tmpl: CsvTemplate = {
      rowMode: 'PER_LINE',
      columns: [
        { header: 'OrderID', source: 'order.shopifyOrderNumber' },
        { header: 'SKU', source: 'line.sku' },
        { header: 'Qty', source: 'line.qty' },
      ],
    }
    const csv = renderCsv(tmpl, [sampleOrder])
    const rows = csv.split('\n')
    expect(rows[0]).toBe('OrderID,SKU,Qty')
    expect(rows[1]).toBe('#1023,TSHIRT-RED-M,2')
    expect(rows[2]).toBe('#1023,HOODIE-BLK-L,1')
    expect(rows).toHaveLength(3)
  })

  it('renders PER_ORDER with one row per order', () => {
    const tmpl: CsvTemplate = {
      rowMode: 'PER_ORDER',
      columns: [
        { header: 'OrderID', source: 'order.shopifyOrderNumber' },
        { header: 'Recipient', source: 'order.customerName' },
      ],
    }
    const csv = renderCsv(tmpl, [sampleOrder])
    expect(csv).toBe('OrderID,Recipient\n#1023,David Olsen')
  })

  it('supports literal: source', () => {
    const tmpl: CsvTemplate = {
      rowMode: 'PER_ORDER',
      columns: [{ header: 'Note', source: 'literal:Rush order' }],
    }
    expect(renderCsv(tmpl, [sampleOrder])).toBe('Note\nRush order')
  })

  it('CSV-escapes fields containing commas or quotes', () => {
    const order: OrderForCsv = { ...sampleOrder, customerName: 'Doe, John "Big"' }
    const tmpl: CsvTemplate = {
      rowMode: 'PER_ORDER',
      columns: [{ header: 'Name', source: 'order.customerName' }],
    }
    expect(renderCsv(tmpl, [order])).toBe('Name\n"Doe, John ""Big"""')
  })
})
