export type FdTicket = {
  id: number
  subject: string
  status: number
  priority: number
  tags: string[]
  created_at: string
  updated_at: string
  description_text?: string
  description?: string
  requester?: { email?: string; name?: string }
  custom_fields?: { cf_order_id?: string | null }
}

export type FdConversation = {
  id: number
  incoming: boolean
  private: boolean
  user_id: number
  body: string
  body_text: string
  from_email?: string | null
  created_at: string
}

export class FreshdeskError extends Error {
  status: number
  retryAfter?: number
  constructor(status: number, message: string, retryAfter?: number) {
    super(`Freshdesk ${status}: ${message}`)
    this.status = status
    this.retryAfter = retryAfter
  }
}

export class FreshdeskBudgetExceeded extends Error {
  constructor(budget: number) { super(`Freshdesk request budget (${budget}) exhausted for this cycle`) }
}

export class FreshdeskClient {
  requests = 0
  private readonly base: string
  private readonly auth: string
  private readonly fetchImpl: typeof fetch
  private readonly budget: number

  constructor(opts: { domain: string; apiKey: string; fetchImpl?: typeof fetch; budget?: number }) {
    this.base = `https://${opts.domain}.freshdesk.com/api/v2`
    this.auth = 'Basic ' + Buffer.from(`${opts.apiKey}:X`).toString('base64')
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.budget = opts.budget ?? 25
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (this.requests >= this.budget) throw new FreshdeskBudgetExceeded(this.budget)
    this.requests += 1
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: { Authorization: this.auth, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      const retry = res.headers.get('Retry-After')
      throw new FreshdeskError(res.status, text.slice(0, 300), retry ? Number(retry) : undefined)
    }
    if (res.status === 204) return undefined as T
    return (await res.json()) as T
  }

  listTickets(updatedSince: string, page = 1): Promise<FdTicket[]> {
    const q = new URLSearchParams({
      updated_since: updatedSince,
      include: 'requester,description',
      per_page: '100',
      order_by: 'updated_at',
      order_type: 'asc',
      page: String(page),
    })
    return this.call('GET', `/tickets?${q.toString()}`)
  }

  getConversations(ticketId: number): Promise<FdConversation[]> {
    return this.call('GET', `/tickets/${ticketId}/conversations`)
  }

  reply(ticketId: number, bodyHtml: string): Promise<{ id: number }> {
    return this.call('POST', `/tickets/${ticketId}/reply`, { body: bodyHtml })
  }

  note(ticketId: number, bodyHtml: string): Promise<{ id: number }> {
    return this.call('POST', `/tickets/${ticketId}/notes`, { body: bodyHtml, private: true })
  }

  async update(ticketId: number, patch: { priority?: number; status?: number; tags?: string[]; custom_fields?: Record<string, string | null> }): Promise<void> {
    await this.call('PUT', `/tickets/${ticketId}`, patch)
  }
}
