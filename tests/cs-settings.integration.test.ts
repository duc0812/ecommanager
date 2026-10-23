import { describe, it, expect, afterAll, beforeEach } from 'vitest'
import { prisma } from '@/lib/db'
import { DEFAULT_CS_SETTINGS, getCsSecrets, getCsSettings, saveCsSecrets, saveCsSettings, toCsSettingsView } from '@/lib/cs/settings'

const KEYS = ['cs.settings', 'cs.freshdeskApiKey', 'cs.anthropicApiKey']
async function clean() { await prisma.appSetting.deleteMany({ where: { key: { in: KEYS } } }) }

beforeEach(clean)
afterAll(clean)

describe('cs settings', () => {
  it('returns defaults when nothing stored', async () => {
    expect(await getCsSettings()).toEqual(DEFAULT_CS_SETTINGS)
  })

  it('patch merges and persists', async () => {
    await saveCsSettings({ autoReplyCategories: ['ORDER_STATUS', 'PRODUCT_QUESTION'], pollEnabled: false })
    const s = await getCsSettings()
    expect(s.autoReplyCategories).toEqual(['ORDER_STATUS', 'PRODUCT_QUESTION'])
    expect(s.pollEnabled).toBe(false)
    expect(s.model).toBe('claude-opus-5-5')
  })

  it('secrets are masked in the view and never returned raw', async () => {
    await saveCsSecrets({ freshdeskApiKey: 'fwapABCDEFGH1234', anthropicApiKey: 'sk-ant-xyz', kieApiKey: 'kie0123456789abcdef' })
    const view = toCsSettingsView(await getCsSettings(), await getCsSecrets())
    expect(view.freshdeskApiKeyMasked).toBe('fwap…1234')
    expect(view.hasAnthropicApiKey).toBe(true)
    expect(view.hasKieApiKey).toBe(true)
    expect(view.kieApiKeyMasked).toBe('kie0…cdef')
    expect(JSON.stringify(view)).not.toContain('sk-ant-xyz')
    expect(JSON.stringify(view)).not.toContain('fwapABCDEFGH1234')
    expect(JSON.stringify(view)).not.toContain('kie0123456789abcdef')
  })

  it('llm provider defaults to kie and only accepts known providers', async () => {
    expect(DEFAULT_CS_SETTINGS.llmProvider).toBe('kie')
    await saveCsSettings({ llmProvider: 'anthropic' })
    expect((await getCsSettings()).llmProvider).toBe('anthropic')
    await saveCsSettings({ llmProvider: 'nope' as any })
    expect((await getCsSettings()).llmProvider).toBe('kie')
  })
})
