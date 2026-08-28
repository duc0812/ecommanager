// Nguồn chân lý duy nhất cho public base URL của app (dùng cho OAuth redirect_uri).
//
// Thứ tự ưu tiên:
//   1. NEXT_PUBLIC_APP_URL — set explicit trên VPS/production (vd "https://app.example.com")
//   2. Suy ra từ request: <proto>://<host>
//      - proto lấy từ x-forwarded-proto (khi sau nginx/reverse-proxy);
//        nếu không có: localhost/127.0.0.1 → http, còn lại → https
//
// Nhờ vậy:
//   - Local (chạy port bất kỳ, vd 8080): tự ra http://localhost:8080
//   - VPS sau proxy HTTPS: set NEXT_PUBLIC_APP_URL=https://domain → redirect_uri luôn khớp

function isLocalHost(host: string): boolean {
  return host.startsWith('localhost') || host.startsWith('127.0.0.1') || host.startsWith('[::1]')
}

export function getPublicBaseUrl(req: Request): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/+$/, '')
  // Chỉ tin NEXT_PUBLIC_APP_URL khi nó là domain thật (production/VPS).
  // Giá trị localhost (thường là leftover trong .env.local) KHÔNG được override
  // host/port thực tế đang chạy — nếu không, đổi port dev là sai redirect_uri.
  if (configured && !isLocalHost(configured.replace(/^https?:\/\//, ''))) return configured

  const host = req.headers.get('host') || 'localhost:3000'
  const proto = req.headers.get('x-forwarded-proto')?.split(',')[0].trim()
    || (isLocalHost(host) ? 'http' : 'https')
  return `${proto}://${host}`
}

export function getShopifyRedirectUri(req: Request): string {
  return `${getPublicBaseUrl(req)}/api/auth/shopify/callback`
}
