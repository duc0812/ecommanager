export function bareDomain(input: string): string {
  return String(input ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^www\./, '')
}

export function domainVariants(input: string): string[] {
  const bare = bareDomain(input)
  return bare ? [bare, `www.${bare}`] : []
}
