import { describe, it, expect, vi } from 'vitest'
import { FreshdeskBudgetExceeded, FreshdeskClient, FreshdeskError } from '@/lib/cs/freshdesk'

function fakeFetch(status = 200, body: unknown = [], headers: Record<string, string> = {}) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } }))
}

describe('FreshdeskClient', () => {
  it('sends basic auth and the list query', async () => {
    const fetchImpl = fakeFetch(200, [{ id: 1 }])
    const fd = new FreshdeskClient({ domain: 'litzzy', apiKey: 'key123', fetchImpl: fetchImpl as any })
    const tickets = await fd.listTickets('2026-10-20T00:00:00Z')
    expect(tickets).toEqual([{ id: 1 }])
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url.startsWith('https://litzzy.freshdesk.com/api/v2/tickets?')).toBe(true)
    expect(url).toContain('updated_since=2026-10-20T00%3A00%3A00Z')
    expect(url).toContain('include=requester%2Cdescription')
    expect(url).toContain('per_page=100')
    expect(url).toContain('order_by=updated_at')
    expect(url).toContain('order_type=asc')
    expect((init.headers as Record<string, string>).Authorization).toBe('Basic ' + Buffer.from('key123:X').toString('base64'))
    expect(fd.requests).toBe(1)
  })

  it('throws FreshdeskError with retryAfter on 429', async () => {
    const fd = new FreshdeskClient({ domain: 'litzzy', apiKey: 'k', fetchImpl: fakeFetch(429, { message: 'slow down' }, { 'Retry-After': '7' }) as any })
    const err = await fd.getConversations(5).catch(e => e)
    expect(err).toBeInstanceOf(FreshdeskError)
    expect(err.status).toBe(429)
    expect(err.retryAfter).toBe(7)
  })

  it('stops at the request budget', async () => {
    const fetchImpl = fakeFetch()
    const fd = new FreshdeskClient({ domain: 'litzzy', apiKey: 'k', fetchImpl: fetchImpl as any, budget: 2 })
    await fd.getConversations(1)
    await fd.getConversations(2)
    await expect(fd.getConversations(3)).rejects.toBeInstanceOf(FreshdeskBudgetExceeded)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('reply posts {body} to /tickets/:id/reply', async () => {
    const fetchImpl = fakeFetch(201, { id: 99 })
    const fd = new FreshdeskClient({ domain: 'litzzy', apiKey: 'k', fetchImpl: fetchImpl as any })
    const res = await fd.reply(119, '<p>Hi</p>')
    expect(res.id).toBe(99)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://litzzy.freshdesk.com/api/v2/tickets/119/reply')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ body: '<p>Hi</p>' })
  })

  it('update sends PUT with the patch and resolves on 200', async () => {
    const fetchImpl = fakeFetch(200, { id: 119 })
    const fd = new FreshdeskClient({ domain: 'litzzy', apiKey: 'k', fetchImpl: fetchImpl as any })
    await fd.update(119, { priority: 4, tags: ['em-urgent'] })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://litzzy.freshdesk.com/api/v2/tickets/119')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body as string)).toEqual({ priority: 4, tags: ['em-urgent'] })
  })
})
