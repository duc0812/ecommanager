function htmlToLines(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h\d|blockquote|table)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/​/g, '')
    .split('\n')
    .map(l => l.replace(/\s+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const lineCount = (s: string) => s.trim().split('\n').filter(l => l.trim()).length

export function displayText(bodyHtml: string | null | undefined, bodyText: string): string {
  if (!bodyHtml || !/<(br|p|div|li|tr)\b/i.test(bodyHtml)) return bodyText
  const fromHtml = htmlToLines(bodyHtml)
  if (!fromHtml) return bodyText
  return lineCount(fromHtml) >= lineCount(bodyText) ? fromHtml : bodyText
}

const QUOTE_MARKERS = [
  /(?:^|\n|\s)On [A-Z][a-z]{2}[^\n]{3,160}?wrote:/m,
  /^-{2,}\s*Original Message\s*-{2,}$/im,
  /^From: .+$/m,
  /(?:^|\n|\s)Sent from my (iPhone|iPad|Galaxy|Samsung|Android|Verizon)/im,
  /(?:^|\n|\s)Get Outlook for (iOS|Android)/im,
]

export function splitQuoted(text: string): { main: string; quoted: string | null } {
  let cut = -1
  for (const re of QUOTE_MARKERS) {
    const m = re.exec(text)
    if (m && m.index > 0 && (cut === -1 || m.index < cut)) cut = m.index
  }
  if (cut === -1) return { main: text.trim(), quoted: null }
  const main = text.slice(0, cut).trim()
  const quoted = text.slice(cut).trim()
  if (!main) return { main: text.trim(), quoted: null }
  return { main, quoted: quoted || null }
}
