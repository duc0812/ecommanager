import { createClient } from '@libsql/client'
import path from 'path'

// After migration 20261029030000_task_key_follows_line_key renumbered design tasks to the order's line key, each task's
// Drive folder still carries the old name (LIT5092_2 for the task now called LIT5092_1). This renames every task folder
// whose name differs from its taskKey. The folder ids, links and files inside stay as they are.
// Reads the tasks and the Google Drive credentials (AppSetting google.*) from a prod database or snapshot taken AFTER
// the migration ran. Dry run by default; --apply renames. Database: a file path argument, else DATABASE_URL.
const argv = process.argv.slice(2)
const apply = argv.includes('--apply')
const fileArg = argv.find(a => !a.startsWith('--'))
const url = fileArg
  ? (fileArg.startsWith('file:') ? fileArg : `file:${path.resolve(process.cwd(), fileArg)}`)
  : process.env.DATABASE_URL?.trim()
if (!url) {
  console.error('cần đường dẫn snapshot prod (sau khi migration đã chạy) hoặc DATABASE_URL')
  process.exit(2)
}
const db = createClient({ url })

const keys = ['google.oauth.clientId', 'google.oauth.clientSecret', 'google.drive.refreshToken']
const settings = Object.fromEntries((await db.execute({ sql: `SELECT key, value FROM AppSetting WHERE key IN (?, ?, ?)`, args: keys })).rows.map(r => [r.key, r.value]))
if (keys.some(k => !settings[k])) {
  console.error('database chưa có kết nối Google Drive (AppSetting google.*)')
  process.exit(2)
}
const migrated = await db.execute(`SELECT COUNT(*) AS n FROM "_prisma_migrations" WHERE migration_name = '20261029030000_task_key_follows_line_key' AND finished_at IS NOT NULL`)
if (Number(migrated.rows[0].n) === 0) {
  console.error('migration 20261029030000_task_key_follows_line_key chưa chạy trên database này — đổi tên thư mục lúc này sẽ lệch với mã task')
  process.exit(2)
}

let token = null
async function accessToken() {
  if (token && token.expiresAt - 60_000 > Date.now()) return token.value
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: settings[keys[0]], client_secret: settings[keys[1]], refresh_token: settings[keys[2]], grant_type: 'refresh_token' }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || typeof data.access_token !== 'string') throw new Error(`Không làm mới được token Google (HTTP ${res.status})`)
  token = { value: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000 }
  return token.value
}
async function drive(id, init = {}) {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=id,name,trashed`, {
    ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${await accessToken()}` },
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Google Drive HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res.json()
}

const tasks = (await db.execute(`SELECT taskKey, driveFolderId FROM DesignTask WHERE driveFolderId IS NOT NULL ORDER BY taskKey`)).rows
let renamed = 0, same = 0, missing = 0, failed = 0
for (const t of tasks) {
  try {
    const folder = await drive(t.driveFolderId)
    if (!folder || folder.trashed) { missing++; continue }
    if (folder.name === t.taskKey) { same++; continue }
    console.log(`${apply ? 'đổi' : 'sẽ đổi'} ${folder.name} → ${t.taskKey}`)
    if (apply) await drive(t.driveFolderId, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: t.taskKey }) })
    renamed++
  } catch (e) {
    failed++
    console.error(`lỗi ${t.taskKey} (${t.driveFolderId}): ${e.message}`)
  }
}
console.log(`${tasks.length} thư mục: ${apply ? 'đã đổi' : 'sẽ đổi'} ${renamed}, đúng tên ${same}, không còn trên Drive ${missing}, lỗi ${failed}${apply ? '' : ' — chạy thử, thêm --apply để đổi'}`)
