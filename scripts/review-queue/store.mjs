import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { createClient } from '@libsql/client'

export const COUNTDOWN_MS = 10_800_000
export const LOCK_STALE_MS = 15 * 60_000
export const ACTIVE_STATUSES = ['waiting', 'rejected', 'fixing', 'qa_failed', 'needs_look']
const COUNTING_STATUSES = ['waiting', 'qa_failed']
export const ALL_STATUSES = [...ACTIVE_STATUSES, 'approved', 'cloud', 'held', 'removed']
const BUSY_TIMEOUT_MS = 5000
const ITEM_ID = /^rq_[A-Za-z0-9]{1,40}$/
export const newItemId = () => `rq_${crypto.randomBytes(8).toString('hex')}`

/**
 * @typedef {'waiting'|'rejected'|'fixing'|'qa_failed'|'needs_look'|'approved'|'cloud'|'held'|'removed'} ItemStatus
 * @typedef {{ part: string, kind: string, path: string, sha256: string }} QueueFile
 * @typedef {{ verdict: 'pass'|'fail'|'unchecked', items: string[] }} QueueQa
 * @typedef {{
 *   id: string, taskKey: string, groupKey: string, kind: 'line'|'group', status: ItemStatus, statusReason: string|null,
 *   prevStatus: string|null, version: number, enteredAt: string, createdAt: string, updatedAt: string,
 *   apiLines: any, meta: any, qa: QueueQa
 * }} QueueItem
 * @typedef {{ itemId: string, n: number, files: QueueFile[], apiLines: any, qa: QueueQa, createdAt: string }} QueueVersion
 * @typedef {{ id: number, itemId: string, type: string, message: string, createdAt: string }} QueueEvent
 */

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    taskKey TEXT NOT NULL,
    groupKey TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    statusReason TEXT,
    prevStatus TEXT,
    version INTEGER NOT NULL,
    enteredAt TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    apiLines TEXT NOT NULL,
    meta TEXT NOT NULL,
    qa TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS items_group ON items (groupKey)`,
  `CREATE INDEX IF NOT EXISTS items_task ON items (taskKey)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS items_one_active_per_group ON items (groupKey)
    WHERE status IN ('waiting','rejected','fixing','qa_failed','needs_look')`,
  `CREATE TABLE IF NOT EXISTS versions (
    itemId TEXT NOT NULL,
    n INTEGER NOT NULL,
    files TEXT NOT NULL,
    apiLines TEXT NOT NULL,
    qa TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    PRIMARY KEY (itemId, n)
  )`,
  `CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    itemId TEXT NOT NULL,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    createdAt TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS events_item ON events (itemId)`,
  `CREATE TABLE IF NOT EXISTS item_keys (
    itemId TEXT NOT NULL,
    taskKey TEXT NOT NULL,
    PRIMARY KEY (itemId, taskKey)
  )`,
  `CREATE INDEX IF NOT EXISTS item_keys_task ON item_keys (taskKey)`,
  `INSERT OR IGNORE INTO item_keys (itemId, taskKey) SELECT id, taskKey FROM items`,
  `CREATE TABLE IF NOT EXISTS locks (
    itemId TEXT PRIMARY KEY,
    pid INTEGER NOT NULL,
    token TEXT NOT NULL,
    takenAt TEXT NOT NULL
  )`,
]

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e?.code === 'EPERM'
  }
}

const json = v => JSON.stringify(v ?? null)
const parse = s => (s == null ? null : JSON.parse(s))

function rowToItem(r) {
  if (!r) return null
  return {
    id: r.id,
    taskKey: r.taskKey,
    groupKey: r.groupKey,
    kind: r.kind,
    status: r.status,
    statusReason: r.statusReason ?? null,
    prevStatus: r.prevStatus ?? null,
    version: Number(r.version),
    enteredAt: r.enteredAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    apiLines: parse(r.apiLines),
    meta: parse(r.meta),
    qa: parse(r.qa),
  }
}

function shaKey(files) {
  return (files ?? []).map(f => f.sha256).sort().join('|')
}

const memberSet = (taskKey, taskKeys) => [...new Set([taskKey, ...(taskKeys ?? [])].filter(Boolean))].sort()

async function readKeys(executor, itemId) {
  const r = await executor.execute({ sql: 'SELECT taskKey FROM item_keys WHERE itemId = ? ORDER BY taskKey', args: [itemId] })
  return r.rows.map(x => x.taskKey)
}

async function writeKeys(executor, itemId, keys) {
  await executor.execute({ sql: 'DELETE FROM item_keys WHERE itemId = ?', args: [itemId] })
  for (const k of keys) await executor.execute({ sql: 'INSERT INTO item_keys (itemId, taskKey) VALUES (?, ?)', args: [itemId, k] })
}

function lockedError(itemId) {
  const err = new Error(`Dòng ${itemId} đang được xử lý bởi tiến trình khác`)
  err.code = 'locked'
  return err
}

/**
 * @param {{ root: string, now?: () => Date, isAlive?: (pid: number) => boolean }} opts
 */
export async function openQueue({ root, now = () => new Date(), isAlive = pidAlive }) {
  fs.mkdirSync(root, { recursive: true })
  const dbPath = path.resolve(root, 'queue.db').replace(/\\/g, '/')
  const db = createClient({ url: `file:${dbPath}` })
  // @libsql/client's local driver hands its connection to a transaction and opens a fresh one on the next call,
  // so the per-connection busy_timeout is re-applied right after every transaction() and at open.
  const setBusy = () => db.execute(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
  // A second transaction() in this process while one is open starts on a fresh connection that has no busy_timeout yet, so its
  // BEGIN fails at once with SQLITE_BUSY: wait and retry (up to the busy timeout) like another process would.
  const isBusy = e => /SQLITE_BUSY/.test(`${e?.code ?? ''} ${e?.message ?? ''}`)
  const retryBusy = async fn => {
    const started = Date.now()
    for (;;) {
      try {
        return await fn()
      } catch (e) {
        if (!isBusy(e) || Date.now() - started > BUSY_TIMEOUT_MS) throw e
        await setBusy().catch(() => {})
        await new Promise(r => setTimeout(r, 15))
      }
    }
  }
  const begin = () => retryBusy(async () => {
    const tx = await db.transaction('write')
    await setBusy()
    return tx
  })
  const write = stmt => retryBusy(() => db.execute(stmt))
  // @libsql/client is not safe for overlapping transactions on one client (two transaction() calls can share one connection),
  // so every database step of this queue object runs one at a time; withLock's own fn runs outside.
  let tail = Promise.resolve()
  const exclusive = fn => {
    const run = tail.then(() => fn())
    tail = run.catch(() => {})
    return run
  }
  await setBusy()
  await db.execute('PRAGMA journal_mode = WAL')
  for (const sql of SCHEMA) await db.execute(sql)

  const iso = () => now().toISOString()

  async function getItem(executor, itemId) {
    const r = await executor.execute({ sql: 'SELECT * FROM items WHERE id = ?', args: [itemId] })
    return rowToItem(r.rows[0])
  }

  const activeMarks = ACTIVE_STATUSES.map(() => '?').join(',')

  const api = {
    root,

    /** @returns {Promise<{ itemId: string, version: number, created: boolean, changed: boolean }>} */
    /**
     * `id` (optional) is used only when a new item is created, so the caller can copy its files under items/<id> first.
     * `taskKeys` are the item's member keys (default: taskKey alone); a different member set is a new version like different files.
     * A member key held by an active item of another group fails with code `key_held` (`err.itemId`, `err.taskKey`), nothing written.
     */
    async addOrUpdate({ id: wantedId, taskKey, taskKeys, groupKey, kind, apiLines, files, meta, qa }) {
      if (wantedId != null && !ITEM_ID.test(wantedId)) throw new Error(`id không hợp lệ: ${wantedId}`)
      const tx = await begin()
      try {
        const t = iso()
        const keys = memberSet(taskKey, taskKeys)
        const held = await tx.execute({
          sql: `SELECT i.id, k.taskKey FROM items i JOIN item_keys k ON k.itemId = i.id
                 WHERE k.taskKey IN (${keys.map(() => '?').join(',')}) AND i.groupKey != ? AND i.status IN (${activeMarks}) LIMIT 1`,
          args: [...keys, groupKey, ...ACTIVE_STATUSES],
        })
        if (held.rows[0]) {
          const err = new Error(`${held.rows[0].taskKey} đã có trong hàng chờ ${held.rows[0].id}`)
          err.code = 'key_held'
          err.itemId = held.rows[0].id
          err.taskKey = held.rows[0].taskKey
          throw err
        }
        const status = qa?.verdict === 'fail' ? 'qa_failed' : 'waiting'
        const found = await tx.execute({
          sql: `SELECT * FROM items WHERE groupKey = ? AND status IN (${activeMarks}) ORDER BY createdAt DESC LIMIT 1`,
          args: [groupKey, ...ACTIVE_STATUSES],
        })
        const cur = rowToItem(found.rows[0])
        if (!cur) {
          const id = wantedId ?? newItemId()
          await tx.execute({
            sql: `INSERT INTO items (id, taskKey, groupKey, kind, status, statusReason, prevStatus, version, enteredAt, createdAt, updatedAt, apiLines, meta, qa)
                  VALUES (?, ?, ?, ?, ?, NULL, NULL, 1, ?, ?, ?, ?, ?, ?)`,
            args: [id, taskKey, groupKey, kind, status, t, t, t, json(apiLines), json(meta), json(qa)],
          })
          await tx.execute({
            sql: 'INSERT INTO versions (itemId, n, files, apiLines, qa, createdAt) VALUES (?, 1, ?, ?, ?, ?)',
            args: [id, json(files), json(apiLines), json(qa), t],
          })
          await writeKeys(tx, id, keys)
          await tx.execute({
            sql: 'INSERT INTO events (itemId, type, message, createdAt) VALUES (?, ?, ?, ?)',
            args: [id, 'created', `Vào hàng chờ (v1, ${status})`, t],
          })
          await tx.commit()
          return { itemId: id, version: 1, created: true, changed: true }
        }
        const curVer = await tx.execute({
          sql: 'SELECT files FROM versions WHERE itemId = ? AND n = ?',
          args: [cur.id, cur.version],
        })
        const curFiles = parse(curVer.rows[0]?.files) ?? []
        const curKeys = await readKeys(tx, cur.id)
        if (shaKey(curFiles) === shaKey(files) && curKeys.join('|') === keys.join('|')) {
          await tx.commit()
          return { itemId: cur.id, version: cur.version, created: false, changed: false }
        }
        const n = cur.version + 1
        // a fix job is running: the new version is the fix's output, the job decides the status afterwards
        const nextStatus = cur.status === 'fixing' ? 'fixing' : status
        await tx.execute({
          sql: 'INSERT INTO versions (itemId, n, files, apiLines, qa, createdAt) VALUES (?, ?, ?, ?, ?, ?)',
          args: [cur.id, n, json(files), json(apiLines), json(qa), t],
        })
        await tx.execute({
          sql: `UPDATE items SET version = ?, enteredAt = ?, updatedAt = ?, apiLines = ?, qa = ?, meta = ?, taskKey = ?, kind = ?,
                status = ?, statusReason = ? WHERE id = ?`,
          args: [
            n, t, t, json(apiLines), json(qa), json(meta ?? cur.meta), taskKey ?? cur.taskKey, kind ?? cur.kind,
            nextStatus, nextStatus === 'fixing' ? cur.statusReason : null, cur.id,
          ],
        })
        await writeKeys(tx, cur.id, keys)
        await tx.execute({
          sql: 'INSERT INTO events (itemId, type, message, createdAt) VALUES (?, ?, ?, ?)',
          args: [cur.id, 'version', `Bản mới v${n} (${nextStatus})`, t],
        })
        await tx.commit()
        return { itemId: cur.id, version: n, created: false, changed: true }
      } finally {
        tx.close()
      }
    },

    /** @returns {Promise<QueueItem|null>} */
    async get(itemId) {
      return getItem(db, itemId)
    },

    /** @returns {Promise<QueueItem[]>} */
    async list({ statuses } = {}) {
      let sql = 'SELECT * FROM items'
      const args = []
      if (statuses?.length) {
        sql += ` WHERE status IN (${statuses.map(() => '?').join(',')})`
        args.push(...statuses)
      }
      sql += ' ORDER BY enteredAt ASC, createdAt ASC'
      const r = await db.execute({ sql, args })
      return r.rows.map(rowToItem)
    },

    /** The active item that holds `taskKey` as any member (a group item is found by every line of the group). @returns {Promise<QueueItem|null>} */
    async activeByTaskKey(taskKey) {
      const r = await db.execute({
        sql: `SELECT i.* FROM items i JOIN item_keys k ON k.itemId = i.id
               WHERE k.taskKey = ? AND i.status IN (${activeMarks}) ORDER BY i.createdAt DESC LIMIT 1`,
        args: [taskKey, ...ACTIVE_STATUSES],
      })
      return rowToItem(r.rows[0])
    },

    /** @returns {Promise<string[]>} sorted member keys of an item */
    async memberKeys(itemId) {
      return readKeys(db, itemId)
    },

    /** Moving to `fixing` remembers the status it came from in `prevStatus`. Moving into an active status fails (code group_active) when the group already has another active item. */
    async setStatus(itemId, status, { reason } = {}) {
      if (!ALL_STATUSES.includes(status)) throw new Error(`Trạng thái không hợp lệ: ${status}`)
      const tx = await begin()
      try {
        const t = iso()
        const cur = await getItem(tx, itemId)
        if (!cur) throw new Error(`Không có dòng ${itemId}`)
        if (ACTIVE_STATUSES.includes(status)) {
          const other = await tx.execute({
            sql: `SELECT id FROM items WHERE groupKey = ? AND id != ? AND status IN (${activeMarks}) LIMIT 1`,
            args: [cur.groupKey, itemId, ...ACTIVE_STATUSES],
          })
          if (other.rows[0]) {
            const err = new Error(`Nhóm ${cur.groupKey} đã có dòng đang hoạt động (${other.rows[0].id})`)
            err.code = 'group_active'
            throw err
          }
        }
        const prev = status === 'fixing' && cur.status !== 'fixing' ? cur.status : status === 'fixing' ? cur.prevStatus : null
        await tx.execute({
          sql: 'UPDATE items SET status = ?, statusReason = ?, prevStatus = ?, updatedAt = ? WHERE id = ?',
          args: [status, reason ?? null, prev, t, itemId],
        })
        await tx.execute({
          sql: 'INSERT INTO events (itemId, type, message, createdAt) VALUES (?, ?, ?, ?)',
          args: [itemId, 'status', reason ? `${status}: ${reason}` : status, t],
        })
        await tx.commit()
      } finally {
        tx.close()
      }
    },

    async addEvent(itemId, type, message) {
      await write({
        sql: 'INSERT INTO events (itemId, type, message, createdAt) VALUES (?, ?, ?, ?)',
        args: [itemId, type, message, iso()],
      })
    },

    /** @returns {Promise<QueueEvent[]>} */
    async events(itemId) {
      const r = await db.execute({ sql: 'SELECT * FROM events WHERE itemId = ? ORDER BY id ASC', args: [itemId] })
      return r.rows.map(e => ({ id: Number(e.id), itemId: e.itemId, type: e.type, message: e.message, createdAt: e.createdAt }))
    },

    /** @returns {Promise<QueueVersion[]>} */
    async versions(itemId) {
      const r = await db.execute({ sql: 'SELECT * FROM versions WHERE itemId = ? ORDER BY n ASC', args: [itemId] })
      return r.rows.map(v => ({
        itemId: v.itemId,
        n: Number(v.n),
        files: parse(v.files),
        apiLines: parse(v.apiLines),
        qa: parse(v.qa),
        createdAt: v.createdAt,
      }))
    },

    /** waiting / qa_failed items whose current version entered at least 3 hours before `at` (Date, epoch ms or ISO string). */
    async expired(at = now()) {
      const cutoff = new Date(new Date(at).getTime() - COUNTDOWN_MS).toISOString()
      const r = await db.execute({
        sql: `SELECT * FROM items WHERE status IN (${COUNTING_STATUSES.map(() => '?').join(',')}) AND enteredAt <= ? ORDER BY enteredAt ASC`,
        args: [...COUNTING_STATUSES, cutoff],
      })
      return r.rows.map(rowToItem)
    },

    /** Process-safe: one holder per item; a lock older than 15 min or owned by a dead pid is taken over. */
    async withLock(itemId, fn) {
      const token = crypto.randomBytes(8).toString('hex')
      await exclusive(async () => {
        const tx = await begin()
        try {
          const r = await tx.execute({ sql: 'SELECT pid, takenAt FROM locks WHERE itemId = ?', args: [itemId] })
          const held = r.rows[0]
          if (held) {
            const age = now().getTime() - Date.parse(held.takenAt)
            const stale = age >= LOCK_STALE_MS || !isAlive(Number(held.pid))
            if (!stale) throw lockedError(itemId)
            await tx.execute({ sql: 'DELETE FROM locks WHERE itemId = ?', args: [itemId] })
          }
          await tx.execute({
            sql: 'INSERT INTO locks (itemId, pid, token, takenAt) VALUES (?, ?, ?, ?)',
            args: [itemId, process.pid, token, iso()],
          })
          await tx.commit()
        } finally {
          tx.close()
        }
      })
      try {
        return await fn()
      } finally {
        await exclusive(() => write({ sql: 'DELETE FROM locks WHERE itemId = ? AND token = ?', args: [itemId, token] }))
      }
    },

    async close() {
      await exclusive(() => db.close())
    },
  }
  for (const name of Object.keys(api)) {
    const f = api[name]
    if (typeof f !== 'function' || name === 'withLock' || name === 'close') continue
    api[name] = (...args) => exclusive(() => f.apply(api, args))
  }
  return api
}
