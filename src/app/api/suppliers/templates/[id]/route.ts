import { NextRequest, NextResponse } from 'next/server'
import { deleteTemplate, getTemplateById, updateTemplate } from '@/lib/repos/templates'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const t = await getTemplateById(params.id)
  if (!t) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(t)
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json()
  try {
    const t = await updateTemplate(params.id, body)
    return NextResponse.json(t)
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 400 })
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  await deleteTemplate(params.id)
  return NextResponse.json({ ok: true })
}
