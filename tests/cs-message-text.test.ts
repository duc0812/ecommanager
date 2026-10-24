import { describe, it, expect } from 'vitest'
import { displayText, splitQuoted } from '@/lib/cs/message-text'

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
