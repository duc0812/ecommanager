import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { consumeOAuthState, setShopifyConnection, getShopifyAppCredentials } from '@/lib/token-store'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const code  = searchParams.get('code') ?? ''
  const shop  = searchParams.get('shop') ?? ''
  const state = searchParams.get('state') ?? ''
  const hmac  = searchParams.get('hmac') ?? ''

  const savedShop = consumeOAuthState(state)
  if (!savedShop) {
    return new NextResponse(errorPage('State không hợp lệ hoặc đã hết hạn.'), { headers: { 'Content-Type': 'text/html' } })
  }

  const appCreds = await getShopifyAppCredentials()
  if (!appCreds) {
    return new NextResponse(errorPage('Không tìm thấy API credentials. Vui lòng thử lại từ Setup.'), { headers: { 'Content-Type': 'text/html' } })
  }

  // Verify HMAC
  const params: Record<string, string> = {}
  searchParams.forEach((v, k) => { if (k !== 'hmac') params[k] = v })
  const message = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&')
  const digest = crypto.createHmac('sha256', appCreds.apiSecret).update(message).digest('hex')
  if (!crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac))) {
    return new NextResponse(errorPage('HMAC không hợp lệ.'), { headers: { 'Content-Type': 'text/html' } })
  }

  // Exchange code for token
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: appCreds.apiKey, client_secret: appCreds.apiSecret, code }),
  })

  if (!res.ok) {
    const text = await res.text()
    return new NextResponse(errorPage(`Token exchange thất bại: ${text}`), { headers: { 'Content-Type': 'text/html' } })
  }

  const { access_token } = await res.json()
  await setShopifyConnection(shop, access_token)

  const response = new NextResponse(successPage(shop), { headers: { 'Content-Type': 'text/html' } })
  // Persist token in httpOnly cookie — survives server restarts without a DB
  response.cookies.set('shopify_shop', shop, { httpOnly: true, path: '/', maxAge: 60 * 60 * 24 * 90 })
  response.cookies.set('shopify_token', access_token, { httpOnly: true, path: '/', maxAge: 60 * 60 * 24 * 90 })
  return response
}

function successPage(shop: string) {
  return `<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8"><title>Kết nối thành công</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f0fdf4}
.card{background:#fff;padding:40px;border-radius:16px;box-shadow:0 4px 20px rgba(0,0,0,.1);text-align:center;max-width:420px}
h2{color:#16a34a;margin-bottom:12px}.btn{display:inline-block;margin-top:20px;padding:10px 24px;background:#16a34a;
color:#fff;border-radius:8px;text-decoration:none;font-weight:600}</style></head>
<body><div class="card"><div style="font-size:48px">✅</div>
<h2>Kết nối thành công!</h2>
<p>Store <b>${shop}</b> đã được kết nối.</p>
<a class="btn" href="/shopify">Xem Payouts →</a></div></body></html>`
}

function errorPage(msg: string) {
  return `<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8"><title>Lỗi</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#fef2f2}
.card{background:#fff;padding:40px;border-radius:16px;box-shadow:0 4px 20px rgba(0,0,0,.1);text-align:center;max-width:420px}
h2{color:#dc2626;margin-bottom:12px}.btn{display:inline-block;margin-top:20px;padding:10px 24px;background:#1a73e8;
color:#fff;border-radius:8px;text-decoration:none;font-weight:600}</style></head>
<body><div class="card"><div style="font-size:48px">❌</div>
<h2>Lỗi kết nối</h2><p>${msg}</p>
<a class="btn" href="/setup">Quay lại Setup</a></div></body></html>`
}
