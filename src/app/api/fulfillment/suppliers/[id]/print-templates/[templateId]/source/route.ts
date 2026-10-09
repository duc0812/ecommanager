import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import { Readable } from 'stream'
import { localTemplatePath, loadSupplierTemplate, SOURCE_MIME } from '@/lib/print-templates'

export async function GET(_req: NextRequest, { params }: { params: { id: string; templateId: string } }) {
  const t = await loadSupplierTemplate(params.id, params.templateId)
  const abs = t ? localTemplatePath(t.sourceFilePath) : null
  if (!t || !abs) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  let size: number
  try { size = (await fs.promises.stat(abs)).size } catch { return NextResponse.json({ error: 'File missing on disk' }, { status: 404 }) }
  const ext = (abs.split('.').pop() ?? '').toLowerCase()
  const name = (t.sourceFileName || `template.${ext}`).replace(/[^A-Za-z0-9._-]/g, '_')
  const body = Readable.toWeb(fs.createReadStream(abs)) as unknown as BodyInit
  return new NextResponse(body, {
    headers: {
      'Content-Type': SOURCE_MIME[ext] ?? 'application/octet-stream',
      'Content-Length': String(size),
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
