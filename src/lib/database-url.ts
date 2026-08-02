import path from 'path'

export function resolveDatabaseUrl(configuredUrl = process.env.DATABASE_URL, cwd = process.cwd()) {
  const configured = configuredUrl?.trim()
  if (!configured) return `file:${path.resolve(cwd, 'dev.db')}`
  if (!configured.startsWith('file:')) return configured

  const configuredPath = configured.slice('file:'.length)
  const absolutePath = path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(cwd, configuredPath)
  return `file:${absolutePath}`
}
