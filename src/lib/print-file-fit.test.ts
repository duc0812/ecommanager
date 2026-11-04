import { describe, expect, it } from 'vitest'
import { printFileFit } from './print-file-fit'

const template = {
  widthPx: 20000, heightPx: 13000,
  areas: [{ name: 'HOOD', w: 4996, h: 3278 }, { name: 'FRONT', w: 5297, h: 5644 }],
  altSets: [{ areas: [{ name: 'HOOD', w: 4958, h: 3278 }, { name: 'FRONT', w: 5297, h: 5644 }] }],
}

describe('printFileFit', () => {
  it('passes the current size of the part', () => {
    expect(printFileFit(template, 'HOOD', { widthPx: 4996, heightPx: 3278 }).state).toBe('ok')
  })

  it('passes a file made for the size the part has in an alternative set', () => {
    expect(printFileFit(template, 'HOOD', { widthPx: 4958, heightPx: 3278 }).state).toBe('ok')
  })

  it('still fails a size no set holds for that part', () => {
    expect(printFileFit(template, 'HOOD', { widthPx: 5297, heightPx: 5644 }).state).toBe('bad')
    expect(printFileFit({ ...template, altSets: undefined }, 'HOOD', { widthPx: 4958, heightPx: 3278 }).state).toBe('bad')
  })
})
