// Split an accumulating NDJSON buffer into complete lines + the leftover partial
// line (a JSON record can be cut in half across two network chunks). Blank lines
// are dropped. Feed `rest` back in with the next chunk.
export function splitNdjson(buffer: string): { lines: string[]; rest: string } {
  const idx = buffer.lastIndexOf('\n')
  if (idx === -1) return { lines: [], rest: buffer }
  const lines = buffer.slice(0, idx).split('\n').filter(l => l.trim().length > 0)
  return { lines, rest: buffer.slice(idx + 1) }
}
