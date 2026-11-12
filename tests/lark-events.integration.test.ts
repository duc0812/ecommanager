import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { canCallApi } from '@/lib/api-access'
import { saveLarkConfig } from '@/lib/lark/settings'
import { larkSignature } from '@/lib/lark/crypto'
import { LARK_TEST_CONFIG as CONFIG, dropLarkSettings, encryptForTest, evt } from './helpers/lark'

const processSpy = vi.hoisted(() => vi.fn(async () => ({ outcome: 'REPLIED', jobIds: [], reply: null })))
vi.mock('@/lib/lark/process', () => ({ processLarkMessage: processSpy }))

import { receiveLarkEvent } from '@/lib/lark/events'
import { POST } from '@/app/api/public/lark/events/route'

const NO_HEADERS = { timestamp: null, nonce: null, signature: null }
const receive = (body: unknown) => receiveLarkEvent(JSON.stringify(body), NO_HEADERS)
const on = () => saveLarkConfig({ ...CONFIG, enabled: true })
const dropEvents = () => prisma.larkEvent.deleteMany({})

beforeAll(async () => { await dropLarkSettings(); await dropEvents() })
afterAll(async () => { await dropLarkSettings(); await dropEvents() })
beforeEach(() => { processSpy.mockClear() })

describe('Lark webhook', () => {
  it('rejects a body that is not JSON', async () => {
    expect(await receiveLarkEvent('not json', NO_HEADERS)).toMatchObject({ status: 400, body: { error: 'bad request' } })
  })

  it('answers the URL check, also while the bot is off', async () => {
    await saveLarkConfig({ ...CONFIG, enabled: false })
    expect(await receive({ type: 'url_verification', token: 'vt-1', challenge: 'abc' })).toMatchObject({ status: 200, body: { challenge: 'abc' } })
    expect((await receive({ type: 'url_verification', token: 'wrong', challenge: 'abc' })).status).toBe(401)
  })

  it('messages while the bot is off leave no trace', async () => {
    expect(await receive(evt())).toMatchObject({ status: 200, body: { ok: true, ignored: 'disabled' } })
    expect(await prisma.larkEvent.count()).toBe(0)
  })

  it('a wrong token is refused, and never echoed', async () => {
    await on()
    const r = await receive(evt({ token: 'nope' }))
    expect(r).toMatchObject({ status: 401, body: { error: 'unauthorized' } })
    expect(JSON.stringify(r.body)).not.toContain('vt-1')
    expect((await receive({ ...evt(), header: { ...evt().header, token: undefined } })).status).toBe(401)
  })

  it('filters: other event, other chat, bot sender, no mention, not text', async () => {
    expect((await receive(evt({ eventType: 'im.chat.member.bot.added_v1' }))).body).toEqual({ ok: true, ignored: 'event_type' })
    expect((await receive(evt({ chatId: 'oc_other' }))).body).toEqual({ ok: true, ignored: 'chat' })
    expect((await receive(evt({ senderType: 'app' }))).body).toEqual({ ok: true, ignored: 'sender' })
    expect((await receive(evt({ messageType: 'image' }))).body).toEqual({ ok: true, ignored: 'message_type' })
    expect((await receive(evt({ mentions: [] }))).body).toEqual({ ok: true, ignored: 'mention' })
    expect(await prisma.larkEvent.count()).toBe(0)
  })

  it("accepts once; Lark's retry of the same event is dropped", async () => {
    const first = await receive(evt({ eventId: 'ev-1', messageId: 'om_1' }))
    expect(first).toMatchObject({
      status: 200, body: { ok: true },
      accepted: { eventId: 'ev-1', messageId: 'om_1', senderOpenId: 'ou_lan', text: '@_user_1 LIT6262_1 sửa sao trên mũ', mentions: [{ key: '@_user_1', openId: 'ou_bot', name: 'Design Bot' }] },
    })
    const again = await receive(evt({ eventId: 'ev-1', messageId: 'om_1' }))
    expect(again.body).toEqual({ ok: true, ignored: 'duplicate' }); expect(again.accepted).toBeUndefined()
    expect(await prisma.larkEvent.count({ where: { eventId: 'ev-1' } })).toBe(1)
    expect(await prisma.larkEvent.findUniqueOrThrow({ where: { eventId: 'ev-1' } })).toMatchObject({ outcome: 'RECEIVED', messageId: 'om_1', senderOpenId: 'ou_lan' })
  })

  it('the same message delivered under a new event id is dropped too', async () => {
    const again = await receive(evt({ eventId: 'ev-1b', messageId: 'om_1' }))
    expect(again.body).toEqual({ ok: true, ignored: 'duplicate' }); expect(again.accepted).toBeUndefined()
  })

  it('encrypted events need a valid signature', async () => {
    await saveLarkConfig({ encryptKey: 'ek' })
    const raw = JSON.stringify({ encrypt: encryptForTest(JSON.stringify(evt({ eventId: 'ev-2' })), 'ek') })
    expect((await receiveLarkEvent(raw, { timestamp: '1', nonce: 'n', signature: 'bad' })).status).toBe(401)
    expect((await receiveLarkEvent(raw, NO_HEADERS)).status).toBe(401)
    expect((await receiveLarkEvent(raw, { timestamp: '1', nonce: 'n', signature: larkSignature('1', 'n', 'ek', raw) })).accepted?.eventId).toBe('ev-2')
    const wrongKey = JSON.stringify({ encrypt: encryptForTest(JSON.stringify(evt({ eventId: 'ev-2b' })), 'other') })
    expect((await receiveLarkEvent(wrongKey, { timestamp: '1', nonce: 'n', signature: larkSignature('1', 'n', 'ek', wrongKey) })).status).toBe(401)
  })

  it('the encrypted URL check is answered by its token', async () => {
    const raw = JSON.stringify({ encrypt: encryptForTest(JSON.stringify({ type: 'url_verification', token: 'vt-1', challenge: 'xyz' }), 'ek') })
    expect(await receiveLarkEvent(raw, NO_HEADERS)).toMatchObject({ status: 200, body: { challenge: 'xyz' } })
    const bad = JSON.stringify({ encrypt: encryptForTest(JSON.stringify({ type: 'url_verification', token: 'no', challenge: 'xyz' }), 'ek') })
    expect((await receiveLarkEvent(bad, NO_HEADERS)).status).toBe(401)
  })

  it('with an Encrypt Key stored, a plain body is refused even with the right token', async () => {
    const plain = await receive(evt({ eventId: 'ev-plain' }))
    expect(plain).toMatchObject({ status: 401, body: { error: 'unauthorized' } }); expect(plain.accepted).toBeUndefined()
    expect((await receive({ type: 'url_verification', token: 'vt-1', challenge: 'abc' })).status).toBe(401)
    const raw = JSON.stringify(evt({ eventId: 'ev-plain-signed' }))
    expect((await receiveLarkEvent(raw, { timestamp: '1', nonce: 'n', signature: larkSignature('1', 'n', 'ek', raw) })).status).toBe(401)
    expect(await prisma.larkEvent.count({ where: { eventId: { startsWith: 'ev-plain' } } })).toBe(0)
  })

  it('an encrypted body without a stored Encrypt Key is refused', async () => {
    await saveLarkConfig({ encryptKey: '-' })
    const raw = JSON.stringify({ encrypt: encryptForTest(JSON.stringify(evt()), 'ek') })
    expect((await receiveLarkEvent(raw, { timestamp: '1', nonce: 'n', signature: larkSignature('1', 'n', '', raw) })).status).toBe(401)
  })

  it('the route answers 200 at once and hands the message to the processor', async () => {
    const res = await POST(new NextRequest('http://localhost/api/public/lark/events', { method: 'POST', body: JSON.stringify(evt({ eventId: 'ev-3' })) }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(processSpy).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'ev-3' }))
    const ignored = await POST(new NextRequest('http://localhost/api/public/lark/events', { method: 'POST', body: JSON.stringify(evt({ chatId: 'oc_other' })) }))
    expect(ignored.status).toBe(200); expect(processSpy).toHaveBeenCalledTimes(1)
    expect(canCallApi(null, [], '/api/public/lark/events', 'POST')).toBe('ok'); expect(canCallApi(null, [], '/api/public/lark/events', 'GET')).toBe('unauthenticated')
  })

  it('the route refuses a body over 1 MB, by its declared length first, then while reading', async () => {
    const declared = await POST(new NextRequest('http://localhost/api/public/lark/events', {
      method: 'POST', headers: { 'content-length': '5000000' }, body: JSON.stringify(evt({ eventId: 'ev-big-1' })),
    }))
    expect(declared.status).toBe(400)
    const big = JSON.stringify({ ...evt({ eventId: 'ev-big-2' }), pad: 'x'.repeat(1_000_001) })
    const read = await POST(new NextRequest('http://localhost/api/public/lark/events', { method: 'POST', body: big }))
    expect(read.status).toBe(400)
    expect(processSpy).not.toHaveBeenCalled()
    expect(await prisma.larkEvent.count({ where: { eventId: { startsWith: 'ev-big' } } })).toBe(0)
  })
})
