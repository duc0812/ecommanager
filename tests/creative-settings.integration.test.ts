import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '@/lib/db'
import { creativeSettingsView, getCreativeSecrets, saveCreativeSecrets } from '@/lib/creative/settings'

const KEYS = ['creative.kieApiKey', 'creative.replicateApiToken', 'cs.kieApiKey']
let envKie: string | undefined
let envRep: string | undefined

beforeAll(async () => {
  envKie = process.env.KIE_API_KEY; envRep = process.env.REPLICATE_API_TOKEN
  delete process.env.KIE_API_KEY; delete process.env.REPLICATE_API_TOKEN
  await prisma.appSetting.deleteMany({ where: { key: { in: KEYS } } })
})
afterAll(async () => {
  await prisma.appSetting.deleteMany({ where: { key: { in: KEYS } } })
  if (envKie !== undefined) process.env.KIE_API_KEY = envKie
  if (envRep !== undefined) process.env.REPLICATE_API_TOKEN = envRep
})

describe('creative secrets', () => {
  it('reports nothing configured when no key exists anywhere', async () => {
    expect(await getCreativeSecrets()).toEqual({ kieApiKey: null, replicateToken: null, kieSource: null })
    const view = await creativeSettingsView()
    expect(view.hasKie).toBe(false)
    expect(view.hasReplicate).toBe(false)
  })

  it('falls back to the CS Kie key and says so', async () => {
    await prisma.appSetting.create({ data: { key: 'cs.kieApiKey', value: 'cs-key-1234567890' } })
    const s = await getCreativeSecrets()
    expect(s.kieApiKey).toBe('cs-key-1234567890')
    expect(s.kieSource).toBe('cs')
    expect((await creativeSettingsView()).kieSource).toBe('cs')
  })

  it('prefers a key pasted on the Creative page over the CS key', async () => {
    await saveCreativeSecrets({ kieApiKey: '  creative-key-abcdefgh  ', replicateToken: 'r8_tokentokentoken' })
    const s = await getCreativeSecrets()
    expect(s.kieApiKey).toBe('creative-key-abcdefgh')
    expect(s.kieSource).toBe('creative')
    expect(s.replicateToken).toBe('r8_tokentokentoken')
    const view = await creativeSettingsView()
    expect(view.kieMasked).toBe('crea…efgh')
    expect(view.replicateMasked).toBe('r8_t…oken')
    expect(view.hasReplicate).toBe(true)
  })

  it('ignores empty values so a blank form does not wipe a saved key', async () => {
    await saveCreativeSecrets({ kieApiKey: '', replicateToken: '   ' })
    const s = await getCreativeSecrets()
    expect(s.kieApiKey).toBe('creative-key-abcdefgh')
    expect(s.replicateToken).toBe('r8_tokentokentoken')
  })

  it('can clear the Creative Kie key to go back to the CS key', async () => {
    await saveCreativeSecrets({ clearKieApiKey: true })
    const s = await getCreativeSecrets()
    expect(s.kieApiKey).toBe('cs-key-1234567890')
    expect(s.kieSource).toBe('cs')
  })
})
