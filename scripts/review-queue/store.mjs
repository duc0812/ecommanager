import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { createClient } from '@libsql/client'

export const COUNTDOWN_MS = 10_800_000
export const LOCK_STALE_MS = 15 * 60_000
export const ACTIVE_STATUSES = ['waiting', 'rejected', 'fixing', 'qa_failed', 'needs_look']
const COUNTING_STATUSES = ['waiting', 'qa_failed']

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
  `CREATE TABLE IF NOT EXISTS locks (
    itemId TEXT PRIMARY KEY,
    pid INTEGER NOT NULL,
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
  await db.execute('PRAGMA busy_timeout = 5000')
  for (const sql of SCHEMA) await db.execute(sql)

  const iso = () => now().toISOString()

  async function getItem(executor, itemId) {
    const r = await executor.execute({ sql: 'SELECT * FROM items WHERE id = ?', args: [itemId] })
    return rowToItem(r.rows[0])
  }

  const activeMarks = ACTIVE_STATUSES.map(() => '?').join(',')

  return {
    root,

    /** @returns {Promise<{ itemId: string, version: number, created: boolean, changed: boolean }>} */
    async addOrUpdate({ taskKey, groupKey, kind, apiLines, files, meta, qa }) {
      const tx = await db.transaction('write')
      try {
        const t = iso()
        const status = qa?.verdict === 'fail' ? 'qa_failed' : 'waiting'
        const found = await tx.execute({
          sql: `SELECT * FROM items WHERE groupKey = ? AND status IN (${activeMarks}) ORDER BY createdAt DESC LIMIT 1`,
          args: [groupKey, ...ACTIVE_STATUSES],
        })
        const cur = rowToItem(found.rows[0])
        if (!cur) {
          const id = `rq_${crypto.randomBytes(8).toString('hex')}`
          await tx.execute({
            sql: `INSERT INTO items (id, taskKey, groupKey, kind, status, statusReason, prevStatus, version, enteredAt, createdAt, updatedAt, apiLines, meta, qa)
                  VALUES (?, ?, ?, ?, ?, NULL, NULL, 1, ?, ?, ?, ?, ?, ?)`,
            args: [id, taskKey, groupKey, kind, status, t, t, t, json(apiLines), json(meta), json(qa)],
          })
          await tx.execute({
            sql: 'INSERT INTO versions (itemId, n, files, apiLines, qa, createdAt) VALUES (?, 1, ?, ?, ?, ?)',
            args: [id, json(files), json(apiLines), json(qa), t],
          })
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
        if (shaKey(curFiles) === shaKey(files)) {
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
          sql: `UPDATE items SET version = ?, enteredAt = ?, updatedAt = ?, apiLines = ?, qa = ?, meta = ?, taskKey = ?,
                status = ?, statusReason = ? WHERE id = ?`,
          args: [
            n, t, t, json(apiLines), json(qa), json(meta ?? cur.meta), taskKey ?? cur.taskKey,
            nextStatus, nextStatus === 'fixing' ? cur.statusReason : null, cur.id,
          ],
        })
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

    /** @returns {Promise<QueueItem|null>} */
    async activeByTaskKey(taskKey) {
      const r = await db.execute({
        sql: `SELECT * FROM items WHERE taskKey = ? AND status IN (${activeMarks}) ORDER BY createdAt DESC LIMIT 1`,
        args: [taskKey, ...ACTIVE_STATUSES],
      })
      return rowToItem(r.rows[0])
    },

    /** Moving to `fixing` remembers the status it came from in `prevStatus`. */
    async setStatus(itemId, status, { reason } = {}) {
      const t = iso()
      const cur = await getItem(db, itemId)
      if (!cur) throw new Error(`Không có dòng ${itemId}`)
      const prev = status === 'fixing' && cur.status !== 'fixing' ? cur.status : status === 'fixing' ? cur.prevStatus : null
      await db.execute({
        sql: 'UPDATE items SET status = ?, statusReason = ?, prevStatus = ?, updatedAt = ? WHERE id = ?',
        args: [status, reason ?? null, prev, t, itemId],
      })
      await db.execute({
        sql: 'INSERT INTO events (itemId, type, message, createdAt) VALUES (?, ?, ?, ?)',
        args: [itemId, 'status', reason ? `${status}: ${reason}` : status, t],
      })
    },

    async addEvent(itemId, type, message) {
      await db.execute({
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

    /** waiting / qa_failed items whose current version entered at least 3 hours before `at`. */
    async expired(at = now()) {
      const cutoff = new Date(at.getTime() - COUNTDOWN_MS).toISOString()
      const r = await db.execute({
        sql: `SELECT * FROM items WHERE status IN (${COUNTING_STATUSES.map(() => '?').join(',')}) AND enteredAt <= ? ORDER BY enteredAt ASC`,
        args: [...COUNTING_STATUSES, cutoff],
      })
      return r.rows.map(rowToItem)
    },

    /** Process-safe: one holder per item; a lock older than 15 min or owned by a dead pid is taken over. */
    async withLock(itemId, fn) {
      const tx = await db.transaction('write')
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
          sql: 'INSERT INTO locks (itemId, pid, takenAt) VALUES (?, ?, ?)',
          args: [itemId, process.pid, iso()],
        })
        await tx.commit()
      } finally {
        tx.close()
      }
      try {
        return await fn()
      } finally {
        await db.execute({ sql: 'DELETE FROM locks WHERE itemId = ? AND pid = ?', args: [itemId, process.pid] })
      }
    },

    async close() {
      db.close()
    },
  }
}
