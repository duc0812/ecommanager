import { NextRequest, NextResponse } from 'next/server'
import { CreativeInputError, modelForm, type Provider } from '@/lib/creative/jobs'
import { loadProviders } from '@/lib/creative/providers'
import { REPLICATE_MODELS } from '@/lib/creative/replicate'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const provider = (req.nextUrl.searchParams.get('provider') ?? 'kie') as Provider
  if (provider !== 'kie' && provider !== 'replicate') return NextResponse.json({ error: 'Provider không hợp lệ' }, { status: 400 })
  const model = req.nextUrl.searchParams.get('model')?.trim()
  const providers = await loadProviders()
  try {
    if (model) {
      const form = await modelForm(provider, model, providers)
      const pricing = provider === 'kie' ? (await providers.kie!.catalog()).find(m => m.slug === model)?.pricing ?? null : null
      return NextResponse.json({ form, pricing })
    }
    if (provider === 'replicate') return NextResponse.json({ models: REPLICATE_MODELS, configured: !!providers.replicate })
    if (!providers.kie) return NextResponse.json({ models: [], configured: false })
    const models = await providers.kie.catalog(req.nextUrl.searchParams.get('refresh') === '1')
    return NextResponse.json({ models, configured: true })
  } catch (err: any) {
    const status = err instanceof CreativeInputError ? 400 : 502
    return NextResponse.json({ error: String(err?.message ?? err) }, { status })
  }
}
