'use client'
import { useEffect, useState } from 'react'

type Row = { id: string; name: string; keywords: string; active: boolean }

function parseKw(json: string): string[] {
  try { const a = JSON.parse(json); return Array.isArray(a) ? a.map(String) : [] } catch { return [] }
}

export default function TaxonomyEditor({ title, endpoint, hint }: { title: string; endpoint: string; hint?: string }) {
  const [rows, setRows] = useState<Row[]>([])
  const [name, setName] = useState('')
  const [keywords, setKeywords] = useState('')

  async function load() { setRows(await fetch(endpoint).then(r => r.json())) }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function add() {
    if (!name.trim()) return
    await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, keywords }) })
    setName(''); setKeywords(''); load()
  }
  async function save(id: string, kw: string) {
    await fetch(endpoint, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, keywords: kw }) })
    load()
  }
  async function remove(id: string) {
    await fetch(endpoint, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })
    load()
  }

  return (
    <>
      <section className="mb-xl rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-lg">
        <div className="grid grid-cols-1 gap-md md:grid-cols-[1fr_2fr_auto]">
          <input value={name} onChange={e => setName(e.target.value)} placeholder={`${title} name`}
            className="rounded-lg border border-outline-variant/30 bg-surface-container px-md py-sm text-body-md outline-none focus:border-secondary" />
          <input value={keywords} onChange={e => setKeywords(e.target.value)} placeholder="keywords: comma, separated"
            className="rounded-lg border border-outline-variant/30 bg-surface-container px-md py-sm text-body-md outline-none focus:border-secondary" />
          <button onClick={add} className="rounded-lg bg-secondary px-lg py-sm text-label-md text-on-secondary">Add</button>
        </div>
        {hint && <p className="mt-xs text-body-sm text-on-surface-variant">{hint}</p>}
      </section>

      <ul className="space-y-sm">
        {rows.map(r => <TaxonomyRow key={r.id} row={r} onSave={save} onRemove={remove} />)}
        {rows.length === 0 && <p className="text-body-md text-on-surface-variant">Nothing yet.</p>}
      </ul>
    </>
  )
}

function TaxonomyRow({ row, onSave, onRemove }: { row: Row; onSave: (id: string, kw: string) => void; onRemove: (id: string) => void }) {
  const [kw, setKw] = useState(parseKw(row.keywords).join(', '))
  return (
    <li className="flex flex-wrap items-center gap-sm rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-md">
      <span className="text-label-md font-bold text-primary">{row.name}</span>
      <input value={kw} onChange={e => setKw(e.target.value)}
        className="min-w-[240px] flex-1 rounded-lg border border-outline-variant/30 bg-surface-container px-md py-xs text-body-sm" />
      <button onClick={() => onSave(row.id, kw)} className="rounded-lg bg-surface-container px-md py-xs text-label-sm">Save</button>
      <button onClick={() => onRemove(row.id)} className="text-error text-label-sm hover:underline">Xoá</button>
    </li>
  )
}
