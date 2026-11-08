import { NextRequest, NextResponse } from 'next/server'
import { requireSuperadmin } from '@/lib/api-auth'
import { getCsSecrets, getCsSettings } from '@/lib/cs/settings'
import { FreshdeskClient } from '@/lib/cs/freshdesk'
import { pickLlmKey, pingFor } from '@/lib/llm/anthropic'
import { JudgemeClient } from '@/lib/cs/judgeme'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const auth = await requireSuperadmin(req)
  if ('error' in auth) return auth.error
  const [settings, secrets] = await Promise.all([getCsSettings(), getCsSecrets()])
  let freshdesk: { ok: boolean; error?: string; tickets?: number } = { ok: false, error: 'Chưa có API key' }
  if (secrets.freshdeskApiKey) {
    try {
      const fd = new FreshdeskClient({ domain: settings.freshdeskDomain, apiKey: secrets.freshdeskApiKey, budget: 2 })
      const since = new Date(Date.now() - 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
      const tickets = await fd.listTickets(since)
      freshdesk = { ok: true, tickets: tickets.length }
    } catch (err: any) {
      freshdesk = { ok: false, error: err?.message ?? String(err) }
    }
  }
  const llmKey = pickLlmKey(settings.llmProvider, secrets)
  const llm = llmKey
    ? await pingFor(settings.llmProvider, settings.model, llmKey)
    : { ok: false, error: `Chưa có API key cho ${settings.llmProvider === 'kie' ? 'Kie' : 'Anthropic'} (bỏ qua)` }
  let judgeme: { ok: boolean; error?: string; reviews?: number } = { ok: false, error: 'Chưa có token' }
  if (secrets.judgemeApiToken) {
    try {
      const reviews = await new JudgemeClient({ token: secrets.judgemeApiToken, shopDomain: settings.judgemeShopDomain }).listReviews({ rating: 1, page: 1, perPage: 1 })
      judgeme = { ok: true, reviews: reviews.length }
    } catch (err: any) {
      judgeme = { ok: false, error: err?.message ?? String(err) }
    }
  }
  return NextResponse.json({ freshdesk, llm, anthropic: llm, judgeme })
}
