import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { prisma } from '@/lib/db'
import { consumeOAuthState } from '@/lib/token-store'
import { saveStoreCredential, shopifyErrorCode } from '@/lib/store-connections'
import { parseScopeList, saveGrantedScopes } from '@/lib/store-connect'
import { escapeHtml, normalizeShopDomain } from '@/lib/shopify-shop'

export const dynamic = 'force-dynamic'

const TOKEN_EXCHANGE_TIMEOUT_MS = 15_000

function html(body: string, status = 200) {
  return new NextResponse(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
}

function safeEqualHex(a: string, b: string) {
  if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b) || a.length !== b.length) return false
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const code = searchParams.get('code') ?? ''
  const shop = normalizeShopDomain(searchParams.get('shop') ?? '')
  const state = searchParams.get('state') ?? ''
  const hmac = searchParams.get('hmac') ?? ''

  if (!shop || !code) return html(errorPage('Thiếu tham số shop hoặc code.'), 400)

  const savedShop = consumeOAuthState(state)
  if (!savedShop || savedShop !== shop) {
    return html(errorPage('State không hợp lệ hoặc đã hết hạn.'), 400)
  }

  const store = await prisma.shopifyStore.findUnique({ where: { shop }, include: { credential: true } })
  const clientId = store?.credential?.clientId
  const clientSecret = store?.credential?.clientSecret
  if (!store || !clientId || !clientSecret) {
    return html(errorPage('Không tìm thấy API credentials của shop này. Vui lòng thử lại từ Setup.'), 400)
  }

  const params: Record<string, string> = {}
  searchParams.forEach((v, k) => { if (k !== 'hmac') params[k] = v })
  const message = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&')
  const digest = crypto.createHmac('sha256', clientSecret).update(message).digest('hex')
  if (!safeEqualHex(digest, hmac)) {
    return html(errorPage('HMAC không hợp lệ.'), 400)
  }

  let res: Response
  try {
    res = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
      redirect: 'error',
      signal: AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS),
    })
  } catch {
    return html(errorPage('Không kết nối được tới Shopify để đổi token. Thử lại sau.'), 502)
  }

  if (!res.ok) {
    const code = shopifyErrorCode(await res.json().catch(() => null))
    console.error('[shopify oauth] token exchange failed', res.status, code ?? '(no error code)')
    return html(errorPage(`Token exchange thất bại (HTTP ${res.status}). Kiểm tra API Key/Secret và thử lại.`), 502)
  }

  const { access_token, scope } = await res.json()
  if (typeof access_token !== 'string' || !access_token) {
    return html(errorPage('Shopify không trả về access token.'), 502)
  }
  await saveStoreCredential(store.id, { authMode: 'OAUTH', clientId, clientSecret, accessToken: access_token, connectedAt: new Date() })
  // The token is saved, so the OAuth is done: scopes that fail to save only leave the card at "chưa kiểm tra" until a re-connect.
  // lastError stays: only the job that failed clears its own error (store-jobs).
  const granted = parseScopeList(scope)
  try {
    if (granted) await saveGrantedScopes(store.id, granted)
  } catch (e) {
    console.error('[shopify oauth] granted scopes not saved', shop, e)
  }

  return html(successPage(shop))
}

function successPage(shop: string) {
  return `<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8"><title>Kết nối thành công</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f0fdf4}
.card{background:#fff;padding:40px;border-radius:16px;box-shadow:0 4px 20px rgba(0,0,0,.1);text-align:center;max-width:420px}
h2{color:#16a34a;margin-bottom:12px}.btn{display:inline-block;margin-top:20px;padding:10px 24px;background:#16a34a;
color:#fff;border-radius:8px;text-decoration:none;font-weight:600}</style></head>
<body><div class="card"><div style="font-size:48px">✅</div>
<h2>Kết nối thành công!</h2>
<p>Store <b>${escapeHtml(shop)}</b> đã được kết nối.</p>
<a class="btn" href="/shopify">Xem Payouts →</a></div></body></html>`
}

function errorPage(msg: string) {
  return `<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8"><title>Lỗi</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#fef2f2}
.card{background:#fff;padding:40px;border-radius:16px;box-shadow:0 4px 20px rgba(0,0,0,.1);text-align:center;max-width:420px}
h2{color:#dc2626;margin-bottom:12px}.btn{display:inline-block;margin-top:20px;padding:10px 24px;background:#1a73e8;
color:#fff;border-radius:8px;text-decoration:none;font-weight:600}</style></head>
<body><div class="card"><div style="font-size:48px">❌</div>
<h2>Lỗi kết nối</h2><p>${escapeHtml(msg)}</p>
<a class="btn" href="/setup">Quay lại Setup</a></div></body></html>`
}
