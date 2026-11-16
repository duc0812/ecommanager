import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { generateWorkerToken, revokeWorkerToken } from '@/lib/artwork-worker'
import { DELIVERY_SWITCH_KEY } from '@/lib/delivery/guard'
import { GET } from '@/app/api/design-studio/worker/delivery/templates/[id]/guide/route'

// The local review page draws the template's artguide under the print files; prod hands it out on the worker token only.
const SUP = 'sup_guide_route'
let token = ''
let storage = ''
let withGuide = ''
let noGuide = ''
let outside = ''
let prevStorage: string | undefined

const req = (id: string, t?: string) => GET(new NextRequest(`http://localhost/api/design-studio/worker/delivery/templates/${id}/guide`, { headers: t ? { authorization: `Bearer ${t}` } : {} }), { params: { id } })

beforeAll(async () => {
  prevStorage = process.env.DESIGN_STORAGE_DIR
  storage = fs.mkdtempSync(path.join(os.tmpdir(), 'guide-route-'))
  process.env.DESIGN_STORAGE_DIR = storage
  await prisma.appSetting.upsert({ where: { key: DELIVERY_SWITCH_KEY }, update: { value: 'true' }, create: { key: DELIVERY_SWITCH_KEY, value: 'true' } })
  token = await generateWorkerToken()
  await prisma.supplier.upsert({ where: { code: SUP }, create: { id: SUP, name: 'Guide route supplier', code: SUP }, update: {} })
  const base = { supplierId: SUP, widthPx: 100, heightPx: 100, areas: '[]' }
  withGuide = (await prisma.printTemplate.create({ data: { ...base, name: 'with guide', guideImagePath: 'templates/g1/guide.png' } })).id
  noGuide = (await prisma.printTemplate.create({ data: { ...base, name: 'no guide' } })).id
  outside = (await prisma.printTemplate.create({ data: { ...base, name: 'outside', guideImagePath: '../secret.png' } })).id
  fs.mkdirSync(path.join(storage, 'templates', 'g1'), { recursive: true })
  fs.writeFileSync(path.join(storage, 'templates', 'g1', 'guide.png'), Buffer.from('PNGBYTES'))
  fs.writeFileSync(path.join(path.dirname(storage), 'secret.png'), Buffer.from('SECRET'))
})

afterAll(async () => {
  await prisma.printTemplate.deleteMany({ where: { supplierId: SUP } })
  await prisma.supplier.deleteMany({ where: { code: SUP } })
  await prisma.appSetting.deleteMany({ where: { key: DELIVERY_SWITCH_KEY } })
  await revokeWorkerToken()
  if (prevStorage === undefined) delete process.env.DESIGN_STORAGE_DIR
  else process.env.DESIGN_STORAGE_DIR = prevStorage
})

describe('GET /api/design-studio/worker/delivery/templates/[id]/guide', () => {
  it('401 without the worker token', async () => {
    expect((await req(withGuide)).status).toBe(401)
  })
  it('serves the guide bytes with the image type on a valid token', async () => {
    const res = await req(withGuide, token)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('PNGBYTES')
  })
  it('404 for a template without a guide, an unknown template, or a path outside storage', async () => {
    expect((await req(noGuide, token)).status).toBe(404)
    expect((await req('nope', token)).status).toBe(404)
    expect((await req(outside, token)).status).toBe(404)
  })
})
