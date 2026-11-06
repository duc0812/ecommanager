import sharp from 'sharp'

const PANEL_HEIGHT = 1536

// Views are generated one by one and joined here: same height, side by side, centred on a white square.
export async function composeViews(parts: Buffer[]): Promise<Buffer> {
  const panels = await Promise.all(parts.map(async bytes => {
    const { data, info } = await sharp(bytes).flatten({ background: '#ffffff' }).resize({ height: PANEL_HEIGHT }).png().toBuffer({ resolveWithObject: true })
    return { data, width: info.width }
  }))
  const totalWidth = panels.reduce((sum, p) => sum + p.width, 0)
  const size = Math.max(totalWidth, PANEL_HEIGHT)
  let left = Math.round((size - totalWidth) / 2)
  const top = Math.round((size - PANEL_HEIGHT) / 2)
  const layers = panels.map(p => { const layer = { input: p.data, left, top }; left += p.width; return layer })
  return sharp({ create: { width: size, height: size, channels: 3, background: '#ffffff' } }).composite(layers).jpeg({ quality: 92 }).toBuffer()
}
