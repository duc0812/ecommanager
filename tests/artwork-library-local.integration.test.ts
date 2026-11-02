import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prisma } from '@/lib/db'
import { LOCAL_LIBRARY_KEY, checklistLibraryState } from '@/lib/artwork-library-state'

const STORE = 'store-local-lib'
const PRODUCT = 'gid://shopify/Product/local-lib-1'
const TEMPLATE = 'tpl-local-lib'
const input = { storeId: STORE, shopifyProductId: PRODUCT, templateId: TEMPLATE, variantOptions: null, artworkSplits: null }
const entry = (over: Record<string, unknown> = {}) => ({ id: 'e1', storeId: STORE, shopifyProductId: PRODUCT, printTemplateId: TEMPLATE, optionKey: '', status: 'READY', ...over })

async function saveLocal(entries: unknown[]) {
  const value = JSON.stringify({ syncedAt: '2026-11-02T12:00:00+00:00', entries })
  await prisma.appSetting.upsert({ where: { key: LOCAL_LIBRARY_KEY }, create: { key: LOCAL_LIBRARY_KEY, value }, update: { value } })
}

beforeEach(async () => { await prisma.appSetting.deleteMany({ where: { key: LOCAL_LIBRARY_KEY } }) })
afterAll(async () => { await prisma.appSetting.deleteMany({ where: { key: LOCAL_LIBRARY_KEY } }) })

describe('checklistLibraryState', () => {
  it('without a synced state it stays with the prod library', async () => {
    expect(await checklistLibraryState(input)).toMatchObject({ status: 'NONE', entryId: null })
    expect((await checklistLibraryState(input))?.source).toBeUndefined()
  })

  it('follows the local library, and gives prod no entry id or layers to act on', async () => {
    await saveLocal([entry()])
    expect(await checklistLibraryState(input)).toMatchObject({ status: 'READY', label: 'Sẵn sàng', entryId: null, layers: [], source: 'LOCAL' })
  })

  it('reports a local entry that is not ready, and a template with no local entry', async () => {
    await saveLocal([entry({ status: 'NEEDS_REVIEW' })])
    expect(await checklistLibraryState(input)).toMatchObject({ status: 'NEEDS_REVIEW', label: 'Thiếu', source: 'LOCAL' })
    await saveLocal([entry({ printTemplateId: 'another-template' })])
    expect(await checklistLibraryState(input)).toMatchObject({ status: 'NONE', source: 'LOCAL' })
  })

  it('a broken synced state falls back to prod instead of failing the task page', async () => {
    await prisma.appSetting.create({ data: { key: LOCAL_LIBRARY_KEY, value: 'not json' } })
    expect(await checklistLibraryState(input)).toMatchObject({ status: 'NONE' })
  })

  it('needs a store, product and template like the prod state', async () => {
    await saveLocal([entry()])
    expect(await checklistLibraryState({ ...input, templateId: null })).toBeNull()
  })
})
