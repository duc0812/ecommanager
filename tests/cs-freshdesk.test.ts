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

  it('outboundEmail posts the payload to /tickets/outbound_email and returns the new ticket', async () => {
    const fetchImpl = fakeFetch(201, { id: 541 })
    const fd = new FreshdeskClient({ domain: 'litzzy', apiKey: 'k', fetchImpl: fetchImpl as any })
    const payload = { email: 'a@b.c', subject: 'Q', description: '<p>Hi</p>', email_config_id: 1, status: 6, priority: 2, tags: ['em-verify-custom'], custom_fields: { cf_order_id: '#LIT1' } }
    expect((await fd.outboundEmail(payload)).id).toBe(541)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://litzzy.freshdesk.com/api/v2/tickets/outbound_email')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual(payload)
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

describe('ticketsByEmail', () => {
  const client = (status: number, body: unknown) => new FreshdeskClient({ domain: 'litzzy', apiKey: 'k', fetchImpl: (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch })
  it('returns the tickets of a known contact', async () => {
    expect(await client(200, [{ id: 5, created_at: '2026-11-01T00:00:00Z' }]).ticketsByEmail('a@b.com')).toEqual([{ id: 5, created_at: '2026-11-01T00:00:00Z' }])
  })
  it('treats "no contact matching the given email" as no tickets', async () => {
    expect(await client(400, { description: 'Validation failed', errors: [{ field: 'email', message: 'There is no contact matching the given email' }] }).ticketsByEmail('new@b.com')).toEqual([])
  })
  it('still throws on other errors', async () => {
    await expect(client(500, {}).ticketsByEmail('a@b.com')).rejects.toThrow()
  })
})

describe('ticketsByEmail window and errors', () => {
  it('asks for tickets updated in the last 90 days', async () => {
    const calls: string[] = []
    const c = new FreshdeskClient({ domain: 'litzzy', apiKey: 'k', fetchImpl: (async (u: string) => { calls.push(String(u)); return new Response('[]', { status: 200 }) }) as unknown as typeof fetch })
    await c.ticketsByEmail('a@b.com', new Date('2026-11-08T00:00:00Z'))
    expect(calls[0]).toContain('updated_since=2026-08-10')
  })
  it('throws on a 400 that is not the unknown-contact answer', async () => {
    const c = new FreshdeskClient({ domain: 'litzzy', apiKey: 'k', fetchImpl: (async () => new Response(JSON.stringify({ description: 'Validation failed', errors: [{ field: 'updated_since', message: 'invalid date' }] }), { status: 400 })) as unknown as typeof fetch })
    await expect(c.ticketsByEmail('a@b.com')).rejects.toThrow()
  })
})
