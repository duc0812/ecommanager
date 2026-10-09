import { NextRequest, NextResponse } from 'next/server'
import { verifyWorkerRequest } from '@/lib/artwork-worker'
import { FieldValidationError, normalizeFields, normalizeFixedTexts, normalizeStrings } from '@/lib/artwork-fields'
import { TooLargeError } from '@/lib/library-storage'
import { MultipartError, cleanupMultipart, parseMultipartToTemp, type MultipartFile, type MultipartResult } from '@/lib/multipart-stream'
import { RESULT_MAX_FILE_BYTES, applyParseResult } from '@/lib/repos/artwork-library'

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function bad(error: string, status = 400) {
  return NextResponse.json({ error }, { status })
}

function pickFile(files: MultipartFile[], base: string): MultipartFile | undefined {
  return files.find(f => f.field === base || f.field === `${base}.png`) ?? files.find(f => f.fileName === `${base}.png`)
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  if (!(await verifyWorkerRequest(req))) return bad('Unauthorized', 401)
  let parts: MultipartResult | null = null
  try {
    parts = await parseMultipartToTemp(req.body, req.headers.get('content-type'), {
      maxFileBytes: RESULT_MAX_FILE_BYTES, maxFieldBytes: 5 * 1024 * 1024, maxParts: 6,
      inMemory: (name, fileName, ct) => name.startsWith('result') || !!fileName?.toLowerCase().endsWith('.json') || !!ct?.includes('json'),
    })
    const raw = parts.fields.result ?? parts.fields['result.json']
    if (!raw) return bad('Thiếu result.json')
    let json: any
    try { json = JSON.parse(raw) } catch { return bad('result.json không phải JSON') }
    if (!json || typeof json !== 'object' || Array.isArray(json)) return bad('result.json phải là object')
    const artwork = pickFile(parts.files, 'artwork')
    if (!artwork) return bad('Thiếu artwork.png')
    const preview = pickFile(parts.files, 'preview') ?? null
    for (const f of [artwork, preview]) {
      if (f && !f.head.subarray(0, 8).equals(PNG_MAGIC)) return bad(`${f.fileName ?? f.field} không phải PNG`)
    }
    const checkScore = json.checkScore === null || json.checkScore === undefined ? null : Number(json.checkScore)
    if (checkScore !== null && !Number.isFinite(checkScore)) return bad('checkScore phải là số')
    const result = {
      fields: normalizeFields(json.fields ?? []),
      fixedTexts: normalizeFixedTexts(json.fixedTexts),
      missingFonts: normalizeStrings(json.missingFonts, 'missingFonts'),
      warnings: normalizeStrings(json.warnings, 'warnings'),
      checkScore,
    }
    const applied = await applyParseResult({ jobId: params.id, result, artwork, preview })
    if (!applied) return bad('Job không còn ở trạng thái RUNNING', 409)
    return NextResponse.json({ ok: true, status: applied.status, entryId: applied.entry.id })
  } catch (err: any) {
    if (err instanceof FieldValidationError || err instanceof MultipartError) return bad(err.message)
    if (err instanceof TooLargeError) return bad(err.message, 413)
    console.error('[artwork worker] result failed:', err?.message ?? err)
    return bad(err?.message ?? 'Lỗi lưu kết quả', 500)
  } finally {
    await cleanupMultipart(parts)
  }
}
