import { NextRequest, NextResponse } from 'next/server'
import { parseDesignLibraryCsv } from '@/lib/design-library'
import { importDesignEntries } from '@/lib/repos/design-library'

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  if (typeof body.csv !== 'string' || !body.csv.trim()) {
    return NextResponse.json({ error: 'csv text is required' }, { status: 400 })
  }
  const { rows, errors: parseErrors } = parseDesignLibraryCsv(body.csv)
  const { upserted, errors: importErrors } = await importDesignEntries(rows)
  return NextResponse.json({ upserted, errors: [...parseErrors, ...importErrors] })
}
