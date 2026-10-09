import { describe, it, expect } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from '@/app/api/design-studio/lines/[lineId]/artwork/route'

describe('POST /api/design-studio/lines/[lineId]/artwork', () => {
  it('refuses a declared body over 200 MB before parsing it', async () => {
    const req = new NextRequest('http://localhost/api/design-studio/lines/x/artwork', {
      method: 'POST',
      headers: { 'content-length': String(201 * 1024 * 1024), 'content-type': 'multipart/form-data; boundary=x' },
      body: 'x',
    })
    const res = await POST(req, { params: { lineId: 'x' } })
    expect(res.status).toBe(413)
    expect((await res.json()).error).toBeTruthy()
  })
})
