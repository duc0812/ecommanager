import { describe, expect, it } from 'vitest'
import { assertSafeExternalUrl, isPrivateHostname } from './safe-url'
import { isValidShopDomain, normalizeShopDomain, escapeHtml } from './shopify-shop'

describe('assertSafeExternalUrl', () => {
  it('accepts public https URLs', () => {
    expect(assertSafeExternalUrl('https://example.com/products/x').hostname).toBe('example.com')
  })
  it('rejects http unless allowed', () => {
    expect(() => assertSafeExternalUrl('http://example.com')).toThrow()
    expect(assertSafeExternalUrl('http://example.com', { allowHttp: true }).protocol).toBe('http:')
  })
  it('rejects private and loopback hosts', () => {
    for (const host of ['127.0.0.1', 'localhost', '10.0.0.5', '192.168.1.1', '172.16.3.3', '169.254.169.254', '[::1]', '[fd00::1]']) {
      expect(() => assertSafeExternalUrl(`https://${host}/x`)).toThrow()
    }
  })
  it('rejects credentials in the URL', () => {
    expect(() => assertSafeExternalUrl('https://user:pw@example.com')).toThrow()
  })
  it('enforces an allow-list', () => {
    expect(assertSafeExternalUrl('https://docs.google.com/spreadsheets/d/1/export', { allowedHosts: ['docs.google.com'] }).hostname).toBe('docs.google.com')
    expect(() => assertSafeExternalUrl('https://evil.com/x', { allowedHosts: ['docs.google.com'] })).toThrow()
    expect(() => assertSafeExternalUrl('https://docs.google.com.evil.com/x', { allowedHosts: ['docs.google.com'] })).toThrow()
  })
  it('flags private hostnames', () => {
    expect(isPrivateHostname('127.0.0.1')).toBe(true)
    expect(isPrivateHostname('example.com')).toBe(false)
  })
})

describe('shop domain helpers', () => {
  it('validates myshopify domains', () => {
    expect(isValidShopDomain('my-store.myshopify.com')).toBe(true)
    expect(isValidShopDomain('evil.com')).toBe(false)
    expect(isValidShopDomain('my-store.myshopify.com.evil.com')).toBe(false)
  })
  it('normalizes scheme and path', () => {
    expect(normalizeShopDomain('https://My-Store.myshopify.com/admin')).toBe('my-store.myshopify.com')
    expect(normalizeShopDomain('evil.com')).toBeNull()
  })
  it('escapes html', () => {
    expect(escapeHtml('<b>"x"</b>')).toBe('&lt;b&gt;&quot;x&quot;&lt;/b&gt;')
  })
})
