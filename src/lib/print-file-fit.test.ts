import { describe, expect, it } from 'vitest'
import { printFileFit } from './print-file-fit'

const template = {
  widthPx: 20000, heightPx: 13000,
  areas: [{ name: 'HOOD', w: 4996, h: 3278 }, { name: 'FRONT', w: 5297, h: 5644 }],
  altSets: [{ areas: [{ name: 'HOOD', w: 4958, h: 3278 }, { name: 'FRONT', w: 5297, h: 5644 }] }],
}

const moved = { ...template, altSets: [{ ...template.altSets[0], filesUntil: '2026-11-04T14:54:03.000Z' }] }

describe('printFileFit', () => {
  it('passes the current size of the part', () => {
    expect(printFileFit(template, 'HOOD', { widthPx: 4996, heightPx: 3278 }).state).toBe('ok')
  })

  it('passes a file made for the size the part has in an alternative set', () => {
    expect(printFileFit(template, 'HOOD', { widthPx: 4958, heightPx: 3278 }).state).toBe('ok')
  })

  it('passes the old layout only for a file made before the template moved', () => {
    const old = { widthPx: 4958, heightPx: 3278 }
    expect(printFileFit(moved, 'HOOD', { ...old, createdAt: '2026-11-03T10:00:00.000Z' }).state).toBe('ok')
    expect(printFileFit(moved, 'HOOD', { ...old, createdAt: new Date('2026-11-05T10:00:00.000Z') }).state).toBe('bad')
    expect(printFileFit(moved, 'HOOD', old).state).toBe('bad')
    expect(printFileFit(moved, 'HOOD', { widthPx: 4996, heightPx: 3278, createdAt: '2026-11-05T10:00:00.000Z' }).state).toBe('ok')
  })

  it('still fails a size no set holds for that part', () => {
    expect(printFileFit(template, 'HOOD', { widthPx: 5297, heightPx: 5644 }).state).toBe('bad')
    expect(printFileFit({ ...template, altSets: undefined }, 'HOOD', { widthPx: 4958, heightPx: 3278 }).state).toBe('bad')
  })
})
