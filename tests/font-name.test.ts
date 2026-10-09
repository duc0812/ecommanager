import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { FontParseError, parseFontName, parseFontNames } from '@/lib/font-name'
import { buildTtc, buildTtf } from './helpers/font-fixture'

describe('font-name', () => {
  it('reads postscript name, family and style from a TTF name table', () => {
    const buf = buildTtf({ 1: 'Brush Script', 2: 'Bold', 4: 'Brush Script Bold', 6: 'BrushScript-Bold' })
    expect(parseFontName(buf)).toEqual({ postscriptName: 'BrushScript-Bold', family: 'Brush Script', style: 'Bold', fullName: 'Brush Script Bold' })
  })

  it('prefers the typographic family and subfamily', () => {
    const buf = buildTtf({ 1: 'Brush Script Light', 2: 'Regular', 6: 'BrushScript-Light', 16: 'Brush Script', 17: 'Light' })
    expect(parseFontName(buf)).toMatchObject({ family: 'Brush Script', style: 'Light' })
  })

  it('reads Mac Roman names and falls back to the full name without spaces', () => {
    const buf = buildTtf({ 1: 'Old Face', 4: 'Old Face Italic' }, 'mac')
    expect(parseFontName(buf)).toMatchObject({ postscriptName: 'OldFaceItalic', family: 'Old Face', style: 'Regular' })
  })

  it('lists every font of a TTC', () => {
    const buf = buildTtc([{ 1: 'Pair', 2: 'Regular', 6: 'Pair-Regular' }, { 1: 'Pair', 2: 'Bold', 6: 'Pair-Bold' }])
    expect(parseFontNames(buf).map(f => f.postscriptName)).toEqual(['Pair-Regular', 'Pair-Bold'])
  })

  it('rejects files that are not fonts', () => {
    expect(() => parseFontName(Buffer.from('8BPS this is a psd, not a font'))).toThrow(FontParseError)
    expect(() => parseFontName(buildTtf({ 1: 'X' }).subarray(0, 40))).toThrow(FontParseError)
  })

  const noto = path.resolve('node_modules/next/dist/compiled/@vercel/og/noto-sans-v27-latin-regular.ttf')
  it.skipIf(!fs.existsSync(noto))('reads a real TTF', () => {
    expect(parseFontName(fs.readFileSync(noto))).toMatchObject({ postscriptName: 'NotoSans-Regular', family: 'Noto Sans', style: 'Regular' })
  })
})
