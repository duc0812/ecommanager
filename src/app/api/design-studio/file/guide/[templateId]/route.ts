import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs/promises'
import path from 'path'
import { prisma } from '@/lib/db'
import { storageRoot } from '@/lib/design-storage'

const EXT_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' }

export async function GET(_req: NextRequest, { params }: { params: { templateId: string } }) {
  const template = await prisma.printTemplate.findUnique({ where: { id: params.templateId }, select: { guideImagePath: true } })
  if (!template?.guideImagePath) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const root = path.resolve(storageRoot())
  const absPath = path.resolve(root, template.guideImagePath)
  if (!absPath.startsWith(root + path.sep)) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const ext = absPath.includes('.') ? absPath.split('.').pop()!.toLowerCase() : ''
  const mimeType = EXT_MIME[ext]
  if (!mimeType) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  let bytes: Buffer
  try {
    bytes = await fs.readFile(absPath)
  } catch {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  return new NextResponse(bytes as unknown as BodyInit, {
    headers: {
      'Content-Type': mimeType,
      'Content-Length': String(bytes.length),
      'Cache-Control': 'private, max-age=3600',
    },
  })
}
