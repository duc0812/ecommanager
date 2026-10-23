import { createClient } from '@libsql/client'
import path from 'path'

// Customer Service pages are gated by the `cs` permission; stored per-user permission lists are not
// re-derived from role defaults, so existing ADMIN / SUPPORT users need it appended once.
const url = process.env.DATABASE_URL?.trim() || `file:${path.resolve(process.cwd(), 'dev.db')}`
const apply = process.argv.includes('--apply')
const db = createClient({ url })

const rows = (await db.execute({ sql: `SELECT id, email, role, permissions FROM "AppUser"`, args: [] })).rows

let unparsable = 0, candidates = 0, already = 0
const toUpdate = []
for (const r of rows) {
  if (r.role !== 'ADMIN' && r.role !== 'SUPPORT') continue
  let perms
  try { perms = JSON.parse(String(r.permissions ?? '[]')) } catch { unparsable++; continue }
  if (!Array.isArray(perms)) { unparsable++; continue }
  candidates++
  if (perms.includes('cs')) { already++; continue }
  toUpdate.push({ id: r.id, email: r.email, role: r.role, next: JSON.stringify([...perms, 'cs']) })
}

console.log(`users=${rows.length} adminOrSupport=${candidates} alreadyHaveCs=${already} toUpdate=${toUpdate.length} unparsable=${unparsable}`)
toUpdate.forEach(u => console.log(`  + cs  ${u.role}  ${u.email}`))
if (apply) for (const u of toUpdate) await db.execute({ sql: `UPDATE "AppUser" SET permissions=? WHERE id=?`, args: [u.next, u.id] })
console.log(apply ? `APPLIED (${toUpdate.length} updated)` : 'DRY-RUN (pass --apply to write)')
