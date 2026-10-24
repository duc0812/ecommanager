import { describe, expect, it } from 'vitest'
import { buildInput, formFromInputSchema } from '@/lib/creative/schema-map'

const seedreamEdit = {
  type: 'object',
  required: ['prompt', 'image_urls', 'aspect_ratio', 'quality'],
  properties: {
    prompt: { type: 'string', description: 'A text description' },
    image_urls: { type: 'array', items: { type: 'string' } },
    aspect_ratio: { type: 'string', enum: ['1:1', '4:3', '3:4', '16:9'] },
    quality: { type: 'string', enum: ['basic', 'high'] },
    nsfw_checker: { type: 'boolean' },
  },
}

const wanImage = {
  type: 'object',
  required: ['prompt'],
  properties: {
    prompt: { type: 'string' },
    input_urls: { type: 'array', items: { type: 'string' } },
    aspect_ratio: { type: 'string', enum: ['1:1', '16:9'], default: '16:9' },
    resolution: { type: 'string', enum: ['1K', '2K'] },
    n: { type: 'integer' },
  },
}

const replicateRoot = {
  components: {
    schemas: {
      aspect_ratio: { type: 'string', enum: ['1:1', '16:9', '9:16'], title: 'aspect_ratio' },
      Input: {
        type: 'object',
        required: ['prompt'],
        properties: {
          prompt: { type: 'string' },
          image: { type: 'string', format: 'uri' },
          aspect_ratio: { allOf: [{ $ref: '#/components/schemas/aspect_ratio' }], default: '1:1' },
          go_fast: { type: 'boolean' },
        },
      },
    },
  },
}

const textOnly = { type: 'object', required: ['prompt'], properties: { prompt: { type: 'string' }, seed: { type: 'integer' } } }

describe('formFromInputSchema', () => {
  it('reads prompt, image array and enum options from a Kie edit schema', () => {
    const form = formFromInputSchema(seedreamEdit)
    expect(form.promptField).toBe('prompt')
    expect(form.imageField).toBe('image_urls')
    expect(form.imageIsArray).toBe(true)
    expect(form.options).toEqual([
      { name: 'aspect_ratio', values: ['1:1', '4:3', '3:4', '16:9'], default: undefined, required: true },
      { name: 'quality', values: ['basic', 'high'], default: undefined, required: true },
    ])
  })

  it('finds an optional input_urls field', () => {
    const form = formFromInputSchema(wanImage)
    expect(form.imageField).toBe('input_urls')
    expect(form.imageIsArray).toBe(true)
    expect(form.options.find(o => o.name === 'aspect_ratio')).toEqual({ name: 'aspect_ratio', values: ['1:1', '16:9'], default: '16:9', required: false })
  })

  it('resolves allOf/$ref enums and a single uri image on a Replicate schema', () => {
    const form = formFromInputSchema(replicateRoot.components.schemas.Input, replicateRoot)
    expect(form.imageField).toBe('image')
    expect(form.imageIsArray).toBe(false)
    expect(form.options).toEqual([{ name: 'aspect_ratio', values: ['1:1', '16:9', '9:16'], default: '1:1', required: false }])
  })

  it('reports no image field on a text-only schema', () => {
    const form = formFromInputSchema(textOnly)
    expect(form.imageField).toBeNull()
    expect(form.options).toEqual([])
  })
})

describe('buildInput', () => {
  it('fills required enums with default or first value when not chosen', () => {
    const input = buildInput(formFromInputSchema(seedreamEdit), { prompt: 'a cat', imageUrls: ['https://x/a.png'], options: {} })
    expect(input).toEqual({ prompt: 'a cat', image_urls: ['https://x/a.png'], aspect_ratio: '1:1', quality: 'basic' })
  })

  it('passes chosen options and leaves optional ones out', () => {
    const input = buildInput(formFromInputSchema(wanImage), { prompt: 'p', imageUrls: [], options: { resolution: '2K' } })
    expect(input).toEqual({ prompt: 'p', resolution: '2K' })
  })

  it('sends only the first url to a single-image field', () => {
    const input = buildInput(formFromInputSchema(replicateRoot.components.schemas.Input, replicateRoot), { prompt: 'p', imageUrls: ['https://x/1.png', 'https://x/2.png'], options: {} })
    expect(input).toEqual({ prompt: 'p', image: 'https://x/1.png' })
  })

  it('throws NO_IMAGE_FIELD when images are given to a text-only model', () => {
    expect(() => buildInput(formFromInputSchema(textOnly), { prompt: 'p', imageUrls: ['https://x/1.png'], options: {} })).toThrow('NO_IMAGE_FIELD')
  })

  it('ignores option values the schema does not list', () => {
    const input = buildInput(formFromInputSchema(wanImage), { prompt: 'p', imageUrls: [], options: { resolution: '8K', bogus: 'x' } })
    expect(input).toEqual({ prompt: 'p' })
  })
})
