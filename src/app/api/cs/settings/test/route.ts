import { NextRequest, NextResponse } from 'next/server'
import { requireSuperadmin } from '@/lib/api-auth'
import { getCsSecrets, getCsSettings } from '@/lib/cs/settings'
import { FreshdeskClient } from '@/lib/cs/freshdesk'
import { pingAnthropic } from '@/lib/llm/anthropic'

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
  const anthropic = secrets.anthropicApiKey
    ? await pingAnthropic(secrets.anthropicApiKey, settings.model)
    : { ok: false, error: 'Chưa có API key (bỏ qua)' }
  return NextResponse.json({ freshdesk, anthropic })
}
