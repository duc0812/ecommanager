import { describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from '@/app/api/projects/analytics/route'

const PID = 'cmp27ew310003hkv9sw0wnb2u' // LZ

describe('analytics route characterization', () => {
  it('matches snapshot for LZ 2026-03-01..2026-07-31', async () => {
    const url = `http://localhost/api/projects/analytics?projectId=${PID}&dateFrom=2026-03-01&dateTo=2026-07-31`
    const res = await GET(new NextRequest(url))
    const json = await res.json()
    // Loại field biến động theo lần chạy (không có timestamp động trong response; project.createdAt cố định).
    expect(json).toMatchSnapshot()
  })
})
