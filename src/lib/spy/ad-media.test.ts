import { describe, it, expect } from 'vitest'
import { extractAdMediaUrl } from './ad-media'

describe('extractAdMediaUrl', () => {
  it('prefers the video preview image (thumbnail)', () => {
    expect(extractAdMediaUrl({ videos: [{ video_preview_image_url: 'https://v/thumb.jpg', video_hd_url: 'x' }] }))
      .toBe('https://v/thumb.jpg')
  })
  it('falls back to image resized then original', () => {
    expect(extractAdMediaUrl({ images: [{ resized_image_url: 'https://i/r.jpg', original_image_url: 'https://i/o.jpg' }] }))
      .toBe('https://i/r.jpg')
    expect(extractAdMediaUrl({ images: [{ original_image_url: 'https://i/o.jpg' }] })).toBe('https://i/o.jpg')
  })
  it('falls back to the first carousel card', () => {
    expect(extractAdMediaUrl({ cards: [{ resized_image_url: 'https://c/r.jpg' }] })).toBe('https://c/r.jpg')
    expect(extractAdMediaUrl({ cards: [{ video_preview_image_url: 'https://c/v.jpg' }] })).toBe('https://c/v.jpg')
  })
  it('returns null when nothing usable / bad input', () => {
    expect(extractAdMediaUrl({ images: [], videos: [], cards: [] })).toBeNull()
    expect(extractAdMediaUrl(null)).toBeNull()
    expect(extractAdMediaUrl('nope')).toBeNull()
  })
})
