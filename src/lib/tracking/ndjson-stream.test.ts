import { describe, it, expect } from 'vitest'
import { splitNdjson } from './ndjson-stream'

describe('splitNdjson', () => {
  it('returns a complete line and empty rest', () => {
    expect(splitNdjson('{"a":1}\n')).toEqual({ lines: ['{"a":1}'], rest: '' })
  })

  it('keeps a partial trailing line in rest', () => {
    expect(splitNdjson('{"a":1}\n{"b":2')).toEqual({ lines: ['{"a":1}'], rest: '{"b":2' })
  })

  it('handles multiple complete lines in one chunk', () => {
    expect(splitNdjson('{"a":1}\n{"b":2}\n')).toEqual({ lines: ['{"a":1}', '{"b":2}'], rest: '' })
  })

  it('returns no lines when there is no newline yet', () => {
    expect(splitNdjson('{"partial')).toEqual({ lines: [], rest: '{"partial' })
  })

  it('drops blank lines between records', () => {
    expect(splitNdjson('{"a":1}\n\n{"b":2}\n')).toEqual({ lines: ['{"a":1}', '{"b":2}'], rest: '' })
  })

  it('handles an empty buffer', () => {
    expect(splitNdjson('')).toEqual({ lines: [], rest: '' })
  })
})
