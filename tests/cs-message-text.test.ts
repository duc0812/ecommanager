import { describe, it, expect } from 'vitest'
import { agentNoteParts, displayText, splitQuoted } from '@/lib/cs/message-text'

describe('displayText', () => {
  it('rebuilds line breaks from the html when body_text lost them', () => {
    const html = '<div>Hi David Deets,<br><br>Thank you for reaching out.</div><div>Status: IN TRANSIT</div><p>Sincerely,<br>litzzy</p>'
    const text = 'Hi David Deets,    Thank you for reaching out.    Status: IN TRANSIT    Sincerely,    litzzy'
    expect(displayText(html, text)).toBe('Hi David Deets,\n\nThank you for reaching out.\nStatus: IN TRANSIT\nSincerely,\nlitzzy')
  })
  it('keeps body_text when there is no html or the text already has line breaks', () => {
    expect(displayText(null, 'a\nb')).toBe('a\nb')
    expect(displayText('<p>x</p>', 'already\nbroken')).toBe('already\nbroken')
  })
  it('collapses runs of blank lines and strips style/script blocks', () => {
    expect(displayText('<style>.a{}</style><p>one</p><p></p><p></p><p>two</p>', 'one two')).toBe('one\n\ntwo')
  })
})

describe('splitQuoted', () => {
  it('splits at an "On … wrote:" marker', () => {
    const r = splitQuoted('I typed it wrong.\n\nOn Oct 14, 2026, at 9:02 AM, Litzzy <support@litzzy.com> wrote:\nDid we get it right?')
    expect(r.main).toBe('I typed it wrong.')
    expect(r.quoted).toContain('Did we get it right?')
  })
  it('splits at the French, Spanish and German reply headers', () => {
    const fr = splitQuoted('1 of 2 not all delevery\n\nLe mer. 11 nov. 2026, 3 h 52 p.m., Litzzy <no-reply@parcelpanel.net> a écrit :\n> Your order has been delivered')
    expect(fr.main).toBe('1 of 2 not all delevery')
    expect(fr.quoted).toContain('Your order has been delivered')
    expect(splitQuoted('1 of 2 not all delevery\n\nLe mer. 11 nov. 2026, 3 h 52 p.m., Litzzy <no-reply@parcelpanel.net> a\nécrit :\n\n> Litzzy').main).toBe('1 of 2 not all delevery')
    expect(splitQuoted('No llegó.\nEl mié, 11 nov 2026 a las 15:52, Litzzy <a@b.c> escribió:\n> hi').main).toBe('No llegó.')
    expect(splitQuoted('Fehlt.\nAm Mi., 11. Nov. 2026 um 15:52 Uhr schrieb Litzzy <a@b.c>:\n> hi').main).toBe('Fehlt.')
  })
  it('splits when the marker sits mid-line after a mobile signature', () => {
    const r = splitQuoted('I spelled it Laurence - no big deal Sent from my iPhone On Oct 14, 2026, at 9:02 AM, Litzzy <support@litzzy.com> wrote: Did we get it right?')
    expect(r.main).toBe('I spelled it Laurence - no big deal')
    expect(r.quoted).toContain('Did we get it right?')
  })
  it('prefers the html text when it carries more line breaks than body_text', () => {
    expect(displayText('<p>a</p><p>b</p><p>c</p>', 'a b\nc')).toBe('a\nb\nc')
  })
  it('splits at a signature-only tail and keeps text without markers whole', () => {
    expect(splitQuoted('Thanks\nSent from my iPhone').main).toBe('Thanks')
    expect(splitQuoted('plain text').quoted).toBeNull()
  })
})

describe('agentNoteParts', () => {
  const note = 'Ecom Manager · Cao · Thiếu hàng · #LIT5554\n\nTóm tắt\nKhách: thiếu Malek\nĐơn hàng: Dự đoán gửi thiếu\nHiện trạng: chờ\n\nĐề xuất\nXin lỗi khách và gửi đơn ngay lập tức.\n\nChi tiết\nTừng sản phẩm:\nLIT5554_1 …\n\nhttps://app/cs/t1'
  it('splits the three-part note', () => {
    expect(agentNoteParts(note)).toEqual({
      head: 'Ecom Manager · Cao · Thiếu hàng · #LIT5554',
      summary: 'Khách: thiếu Malek\nĐơn hàng: Dự đoán gửi thiếu\nHiện trạng: chờ',
      proposal: 'Xin lỗi khách và gửi đơn ngay lập tức.',
      details: 'Từng sản phẩm:\nLIT5554_1 …\n\nhttps://app/cs/t1',
    })
  })
  it('the details heading may run into its first line when the html folded it', () => {
    expect(agentNoteParts(note.replace('Chi tiết\nTừng', 'Chi tiếtTừng'))?.details.startsWith('Từng sản phẩm:')).toBe(true)
  })
  it('any other note is not one', () => {
    expect(agentNoteParts('Ecom Manager · Cao · Thiếu hàng\n\nKhách xác nhận thiếu\n\nĐề xuất: x')).toBeNull()
    expect(agentNoteParts('Called the customer')).toBeNull()
  })
})
