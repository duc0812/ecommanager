const PRIVATE_HOST_PATTERNS: RegExp[] = [
  /^localhost$/,
  /\.local$/,
  /^0\.0\.0\.0$/,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^169\.254\./,
  /^::1$/,
  /^::ffff:(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[0-1])\.)/,
  /^::ffff:7f[0-9a-f]{2}:/,
  /^::ffff:0?a[0-9a-f]{2}:/,
  /^::ffff:c0a8:/,
  /^::ffff:a9fe:/,
  /^::ffff:ac1[0-9a-f]:/,
  /^fc[0-9a-f]{2}:/,
  /^fd[0-9a-f]{2}:/,
  /^fe80:/,
]

export function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return PRIVATE_HOST_PATTERNS.some(re => re.test(host))
}

export type SafeUrlOptions = {
  allowHttp?: boolean
  allowedHosts?: (string | RegExp)[]
}

export function assertSafeExternalUrl(value: string, opts: SafeUrlOptions = {}): URL {
  let parsed: URL
  try {
    parsed = new URL(value.trim())
  } catch {
    throw new Error('URL không hợp lệ')
  }
  const protocolOk = parsed.protocol === 'https:' || (opts.allowHttp && parsed.protocol === 'http:')
  if (!protocolOk) throw new Error(opts.allowHttp ? 'Chỉ hỗ trợ http/https' : 'Chỉ hỗ trợ https')
  if (parsed.username || parsed.password) throw new Error('URL không được chứa thông tin đăng nhập')
  if (isPrivateHostname(parsed.hostname)) throw new Error('Không cho phép địa chỉ nội bộ/private')
  if (opts.allowedHosts && opts.allowedHosts.length > 0) {
    const host = parsed.hostname.toLowerCase()
    const ok = opts.allowedHosts.some(rule => typeof rule === 'string' ? host === rule || host.endsWith(`.${rule}`) : rule.test(host))
    if (!ok) throw new Error(`Host ${host} không nằm trong danh sách cho phép`)
  }
  return parsed
}
