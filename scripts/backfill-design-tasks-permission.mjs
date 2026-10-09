import { createClient } from '@libsql/client'
import path from 'path'

// /design-studio moved from fulfillment_design_library to design_tasks; stored per-user permission
// lists are not re-derived from role defaults, so existing holders need design_tasks appended.
const url = process.env.DATABASE_URL?.trim() || `file:${path.resolve(process.cwd(), 'dev.db')}`
const apply = process.argv.includes('--apply')
const db = createClient({ url })

const rows = (await db.execute({ sql: `SELECT id, email, role, permissions FROM "AppUser"`, args: [] })).rows

let unparsable = 0, holders = 0, already = 0
const toUpdate = []
for (const r of rows) {
  let perms
  try { perms = JSON.parse(String(r.permissions ?? '[]')) } catch { unparsable++; continue }
  if (!Array.isArray(perms)) { unparsable++; continue }
  if (!perms.includes('fulfillment_design_library')) continue
  holders++
  if (perms.includes('design_tasks')) { already++; continue }
  toUpdate.push({ id: r.id, email: r.email, role: r.role, next: JSON.stringify([...perms, 'design_tasks']) })
}

console.log(`users=${rows.length} withDesignLibrary=${holders} alreadyHaveDesignTasks=${already} toUpdate=${toUpdate.length} unparsable=${unparsable}`)
toUpdate.forEach(u => console.log(`  + design_tasks  ${u.role}  ${u.email}`))
if (apply) for (const u of toUpdate) await db.execute({ sql: `UPDATE "AppUser" SET permissions=? WHERE id=?`, args: [u.next, u.id] })
console.log(apply ? `APPLIED (${toUpdate.length} updated)` : 'DRY-RUN (pass --apply to write)')
