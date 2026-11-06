import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '@/lib/db'
import { DEFAULT_SCALE_SETTINGS, ScaleInputError, explainKieError, getScaleSettings, saveScaleSettings, scaleSettingsView } from '@/lib/scale/settings'

const KEYS = ['scale.settings', 'cs.settings', 'cs.kieApiKey', 'creative.kieApiKey']
let envKie: string | undefined

beforeAll(async () => {
  envKie = process.env.KIE_API_KEY
  delete process.env.KIE_API_KEY
  await prisma.appSetting.deleteMany({ where: { key: { in: KEYS } } })
})
afterAll(async () => {
  await prisma.appSetting.deleteMany({ where: { key: { in: KEYS } } })
  if (envKie !== undefined) process.env.KIE_API_KEY = envKie
})

describe('scale settings', () => {
  it('starts from the defaults: GPT Image first, seedream as a fallback that is switched off', async () => {
    expect(await getScaleSettings()).toEqual(DEFAULT_SCALE_SETTINGS)
    expect(DEFAULT_SCALE_SETTINGS).toMatchObject({ imageModel: 'gpt-image-2-5-flare-image-to-image', fallbackModel: 'seedream/4.5-edit', allowFallback: false, visionModel: null, resolution: '2K' })
  })

  it('saves a patch and reads it back', async () => {
    await saveScaleSettings({ allowFallback: true, resolution: '4K' })
    expect(await getScaleSettings()).toMatchObject({ allowFallback: true, resolution: '4K', imageModel: DEFAULT_SCALE_SETTINGS.imageModel })
  })

  it('rejects a model slug that could escape the Kie URL', async () => {
    await expect(saveScaleSettings({ imageModel: '../x' })).rejects.toBeInstanceOf(ScaleInputError)
    expect((await getScaleSettings()).imageModel).toBe(DEFAULT_SCALE_SETTINGS.imageModel)
  })

  it('reads the vision model live from CS settings until its own is set', async () => {
    await prisma.appSetting.create({ data: { key: 'cs.settings', value: JSON.stringify({ model: 'gpt-6.1-sol', llmProvider: 'kie' }) } })
    expect((await scaleSettingsView()).effectiveVisionModel).toBe('gpt-6.1-sol')
    await saveScaleSettings({ visionModel: 'gpt-7-vision' })
    expect((await scaleSettingsView()).effectiveVisionModel).toBe('gpt-7-vision')
    await saveScaleSettings({ visionModel: null })
    expect((await scaleSettingsView()).effectiveVisionModel).toBe('gpt-6.1-sol')
  })

  it('shows both keys masked and never in full', async () => {
    await prisma.appSetting.create({ data: { key: 'cs.kieApiKey', value: 'cs-key-1234567890' } })
    await prisma.appSetting.create({ data: { key: 'creative.kieApiKey', value: 'creative-key-abcdefgh' } })
    const view = await scaleSettingsView()
    expect(view.imageKeyMasked).toBe('crea…efgh')
    expect(view.imageKeySource).toBe('creative')
    expect(view.visionKeyMasked).toBe('cs-k…7890')
    expect(JSON.stringify(view)).not.toContain('creative-key-abcdefgh')
    expect(JSON.stringify(view)).not.toContain('cs-key-1234567890')
  })

  it('names the key and the model when Kie refuses a model', () => {
    expect(explainKieError(new Error('kie createTask 401: The API key is not authorized to use this model.'), 'Creative', 'gpt-x')).toBe('Key Kie (Creative) chưa được cấp quyền model gpt-x')
    expect(explainKieError(new Error('kie error 401: Invalid API key'), 'CS', 'gpt-6.1-sol')).toBe('Key Kie (CS) bị từ chối (401): kie error 401: Invalid API key')
    expect(explainKieError(new Error('kie createTask 422: width 1401 is too large'), 'Creative', 'gpt-x')).toBe('kie createTask 422: width 1401 is too large')
    expect(explainKieError(new Error('kie createTask 500: boom'), 'Creative', 'gpt-x')).toBe('kie createTask 500: boom')
  })
})
