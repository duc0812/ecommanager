'use client'

import { useState } from 'react'
import Link from 'next/link'

type Result = { key: string; ok: boolean; sku?: string; error?: string }

export default function SupplierRefusalPage() {
  const [lines, setLines] = useState('')
  const [reason, setReason] = useState('')
  const [results, setResults] = useState<Result[]>([])
  const [phase, setPhase] = useState<'edit' | 'checked' | 'applied'>('edit')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  function reset() { setPhase('edit'); setResults([]); setError('') }
  async function submit(action: 'check' | 'apply') {
    setBusy(true)
    setError('')
    try {
      const entries = lines.trim().split(/\r?\n/).map(row => {
        const [key, sourceSku, targetSku, sheetRow] = row.trim().split(/\s+/)
        return { key, sourceSku, targetSku, sheetRow: Number(sheetRow) }
      })
      const resp = await fetch('/api/design-studio/supplier-refusal', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lines: entries, reason, action }),
      })
      const data = await resp.json()
      if (!resp.ok) throw new Error(data.error ?? 'Không xử lý được danh sách')
      setResults(data.results)
      setPhase(action === 'check' ? 'checked' : 'applied')
    } catch (e) { setError(e instanceof Error ? e.message : 'Mất kết nối'); setPhase('edit') }
    finally { setBusy(false) }
  }
  return <main className="max-w-4xl mx-auto p-xl space-y-md">
    <Link href="/design-studio?stream=HANDOFF" className="text-secondary">← Design Studio</Link>
    <h1 className="text-headline-md font-semibold">Litzzy Inhouse từ chối sản xuất</h1>
    <p>Chuyển các dòng đã đối chiếu sang ToAddit và mở lại design. Phiên bản file của xưởng cũ nằm trong lịch sử.</p>
    <label className="block">Mã dòng · SKU xưởng cũ · SKU ToAddit · số dòng sheet (0 nếu chưa có)
      <textarea value={lines} disabled={busy} rows={10} onChange={e => { setLines(e.target.value); reset() }} className="block w-full border rounded-lg p-md font-mono" />
    </label>
    <label className="block">Lý do chuyển xưởng
      <input value={reason} disabled={busy} maxLength={500} onChange={e => { setReason(e.target.value); reset() }} className="block w-full border rounded-lg p-sm" />
    </label>
    <div className="flex gap-md"><button disabled={busy || !lines.trim() || !reason.trim()} onClick={() => submit('check')} className="border rounded-lg px-md py-sm">Đối chiếu danh sách</button>
    {phase === 'checked' && results.length > 0 && results.every(r => r.ok) && <button disabled={busy} onClick={() => submit('apply')} className="bg-secondary text-on-secondary rounded-lg px-md py-sm">Chuyển xưởng và mở lại design</button>}</div>
    {busy && <p role="status">Đang kiểm tra sheet và từng dòng đơn…</p>}
    {error && <p role="alert" className="text-error">{error}</p>}
    {!!results.length && <section><h2 className="font-semibold">{phase === 'applied' ? 'Đã chuyển' : 'Đủ điều kiện'} {results.filter(r => r.ok).length}/{results.length} dòng</h2>
      <ul>{results.map(r => <li key={r.key}>{r.key} · {r.ok ? r.sku : r.error}</li>)}</ul></section>}
  </main>
}
