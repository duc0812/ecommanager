// Read-only: per-store numbers, to prove the first store does not move when another store is added.
//   node scripts/multistore-baseline.mjs <db>                        JSON on stdout (keep it as the baseline)
//   node scripts/multistore-baseline.mjs <db> --compare <file.json>  plain-text differences against that baseline
// Exit 0 = fine, 1 = a baseline store lost orders/payouts or its numbers present at the baseline moved,
// 2 = bad arguments or unreadable database/baseline. An order existed at the baseline when it was first fetched by then
// (Order.fetchedAt, placedAt when null), so an order placed earlier but synced later is new; payouts are cut by date.
import { createClient } from '@libsql/client'
import fs from 'node:fs'
import path from 'node:path'

const UTC = col => `strftime('%Y-%m-%dT%H:%M:%fZ', ${col})`
const money = v => Math.round(Number(v ?? 0) * 100) / 100
const cents = v => Math.round(v * 100)
const fmt = v => (Math.round(v * 100) / 100 + 0).toFixed(2)
const die = message => { throw new Error(message) }

const ALLOWED_SQL = /^\s*(select\b|begin\s*$|rollback\s*$|pragma\s+(query_only|busy_timeout)\b)/i

// client.transaction() swaps in a fresh connection that has lost query_only, so BEGIN goes through execute() on the one connection.
async function exec(db, sql, args = []) {
  if (!ALLOWED_SQL.test(sql)) die(`refusing to run anything but reads: ${sql.slice(0, 60)}`)
  return (await db.execute({ sql, args })).rows
}

async function openReadOnly(file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) die(`database not found: ${file}`)
  const abs = path.resolve(file).replace(/\\/g, '/').replace(/[%?#]/g, c => encodeURIComponent(c))
  const db = createClient({ url: `file:${abs}` })
  await exec(db, 'PRAGMA query_only = ON')
  const [flag] = await exec(db, 'PRAGMA query_only')
  if (Number(flag?.query_only) !== 1) die('could not switch the connection to query_only')
  await exec(db, 'PRAGMA busy_timeout = 15000')
  return db
}

const byStore = rows => new Map(rows.map(r => [r.storeId, r]))
const countTotal = row => ({ count: Number(row?.n ?? 0), total: money(row?.total) })

// atTakenAt holds the records that existed at `cutoff`: this run's takenAt for a baseline, the baseline's takenAt when comparing.
async function collect(db, cutoff) {
  const [{ n: hasPrefix }] = await exec(db, `SELECT count(*) AS n FROM pragma_table_info('ShopifyStore') WHERE name = 'orderPrefix'`)
  const stores = await exec(db, `SELECT id, shop, ${Number(hasPrefix) ? 'orderPrefix' : 'NULL'} AS orderPrefix FROM ShopifyStore ORDER BY shop`)
  const orders = byStore(await exec(db, `SELECT storeId, count(*) AS n, sum(grossAmount) AS total FROM "Order" GROUP BY storeId`))
  const ordersAt = byStore(await exec(db, `SELECT storeId, count(*) AS n, sum(grossAmount) AS total FROM "Order" WHERE ${UTC('coalesce(fetchedAt, placedAt)')} <= ? GROUP BY storeId`, [cutoff]))
  const payouts = byStore(await exec(db, `SELECT storeId, count(*) AS n, sum(amount) AS total FROM Payout GROUP BY storeId`))
  const payoutsAt = byStore(await exec(db, `SELECT storeId, count(*) AS n, sum(amount) AS total FROM Payout WHERE ${UTC('date')} <= ? GROUP BY storeId`, [cutoff]))
  const tasks = await exec(db, `SELECT o.storeId AS storeId, t.status AS status, count(*) AS n FROM DesignTask t JOIN "Order" o ON o.id = t.orderId GROUP BY o.storeId, t.status ORDER BY t.status`)
  const shipments = byStore(await exec(db, `SELECT o.storeId AS storeId, count(*) AS n FROM Shipment s JOIN "Order" o ON o.id = s.orderId GROUP BY o.storeId`))

  const result = {}
  for (const s of stores) {
    const byStatus = {}
    for (const t of tasks) if (t.storeId === s.id) byStatus[t.status] = Number(t.n)
    const o = countTotal(orders.get(s.id)), oAt = countTotal(ordersAt.get(s.id))
    const p = countTotal(payouts.get(s.id)), pAt = countTotal(payoutsAt.get(s.id))
    result[s.shop] = {
      storeId: s.id,
      orderPrefix: s.orderPrefix ?? null,
      orders: { count: o.count, grossTotal: o.total },
      payouts: { count: p.count, total: p.total },
      atTakenAt: {
        orders: { count: oAt.count, grossTotal: oAt.total },
        payouts: { count: pAt.count, total: pAt.total },
      },
      designTasks: { total: Object.values(byStatus).reduce((a, b) => a + b, 0), byStatus },
      shipments: Number(shipments.get(s.id)?.n ?? 0),
    }
  }
  return result
}

function readBaseline(file) {
  if (!fs.existsSync(file)) die(`baseline file not found: ${file}`)
  const buf = fs.readFileSync(file)
  const text = (buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le') : buf.toString('utf8')).replace(/^﻿/, '')
  let baseline
  try { baseline = JSON.parse(text) } catch { die(`${file} is not a baseline written by this script (not JSON)`) }
  const shaped = s => s?.orders && s.payouts && s.atTakenAt?.orders && s.atTakenAt?.payouts && s.designTasks?.byStatus && 'shipments' in s
  if (!Number.isFinite(Date.parse(baseline?.takenAt)) || !baseline.stores || !Object.values(baseline.stores).every(shaped)) {
    die(`${file} is not a baseline written by this script`)
  }
  return baseline
}

function compare(baseline, current, comparedAt) {
  const lines = [`Baseline taken at ${baseline.takenAt}, compared at ${comparedAt}`]
  let failures = 0
  const fail = (shop, text) => { failures++; lines.push(`FAIL ${shop}: ${text}`) }
  const verdict = (shop, label, before, after, equal, show = String) => {
    const text = `${label}: ${show(before)} -> ${show(after)}`
    if (equal) lines.push(`  ${text}`)
    else fail(shop, text)
  }

  for (const [shop, was] of Object.entries(baseline.stores)) {
    const now = current[shop]
    if (!now) {
      fail(shop, `store is not in the database any more (baseline had ${was.orders.count} orders, ${was.payouts.count} payouts)`)
      continue
    }
    lines.push(now.orderPrefix ? `${shop} (${now.orderPrefix})` : shop)
    for (const [what, a, b] of [['orders', was.orders.count, now.orders.count], ['payouts', was.payouts.count, now.payouts.count]]) {
      if (b < a) fail(shop, `${what} lost: ${a - b} (baseline had ${a}, now ${b})`)
    }
    const wasAt = was.atTakenAt, nowAt = now.atTakenAt
    verdict(shop, 'orders present at the baseline', wasAt.orders.count, nowAt.orders.count, wasAt.orders.count === nowAt.orders.count)
    verdict(shop, 'orders gross total present at the baseline', wasAt.orders.grossTotal, nowAt.orders.grossTotal, cents(wasAt.orders.grossTotal) === cents(nowAt.orders.grossTotal), fmt)
    verdict(shop, 'payouts dated at or before the baseline', wasAt.payouts.count, nowAt.payouts.count, wasAt.payouts.count === nowAt.payouts.count)
    verdict(shop, 'payouts total dated at or before the baseline', wasAt.payouts.total, nowAt.payouts.total, cents(wasAt.payouts.total) === cents(nowAt.payouts.total), fmt)

    const after = (s, kind, field) => s[kind][field] - s.atTakenAt[kind][field]
    const newOrders = after(now, 'orders', 'count') - after(was, 'orders', 'count')
    const newGross = after(now, 'orders', 'grossTotal') - after(was, 'orders', 'grossTotal')
    const newPayouts = after(now, 'payouts', 'count') - after(was, 'payouts', 'count')
    const newPayoutTotal = after(now, 'payouts', 'total') - after(was, 'payouts', 'total')
    if (newOrders || newPayouts) {
      lines.push(`  new since the baseline: ${newOrders} orders (gross total ${fmt(newGross)}), ${newPayouts} payouts (total ${fmt(newPayoutTotal)})`)
    }

    const statuses = [...new Set([...Object.keys(was.designTasks.byStatus), ...Object.keys(now.designTasks.byStatus)])].sort()
    const moved = statuses
      .filter(s => (was.designTasks.byStatus[s] ?? 0) !== (now.designTasks.byStatus[s] ?? 0))
      .map(s => `${s} ${was.designTasks.byStatus[s] ?? 0} -> ${now.designTasks.byStatus[s] ?? 0}`)
    lines.push(moved.length
      ? `  design tasks (information): ${was.designTasks.total} -> ${now.designTasks.total} (${moved.join(', ')})`
      : `  design tasks (information): ${now.designTasks.total}, unchanged`)
    lines.push(`  shipments (information): ${was.shipments} -> ${now.shipments}`)
  }

  for (const [shop, now] of Object.entries(current)) {
    if (!baseline.stores[shop]) lines.push(`${shop}: not in the baseline, not compared (${now.orders.count} orders, ${now.payouts.count} payouts)`)
  }
  lines.push(failures ? `RESULT: FAIL (${failures} problems)` : 'RESULT: OK')
  return { lines, failures }
}

function parseArgs(argv) {
  const rest = [...argv]
  let comparePath = null
  const at = rest.indexOf('--compare')
  if (at !== -1) {
    comparePath = rest[at + 1]
    if (!comparePath || comparePath.startsWith('--')) die('--compare needs a baseline file')
    rest.splice(at, 2)
  }
  if (rest.length !== 1 || rest[0].startsWith('--')) die('usage: node scripts/multistore-baseline.mjs <db> [--compare <file.json>]')
  return { dbPath: rest[0], comparePath }
}

async function main() {
  const { dbPath, comparePath } = parseArgs(process.argv.slice(2))
  const baseline = comparePath ? readBaseline(comparePath) : null
  const db = await openReadOnly(dbPath)
  try {
    const takenAt = new Date().toISOString()
    await exec(db, 'BEGIN')
    let stores
    try {
      stores = await collect(db, baseline ? new Date(baseline.takenAt).toISOString() : takenAt)
    } finally {
      await exec(db, 'ROLLBACK')
    }
    if (!baseline) {
      console.log(JSON.stringify({ takenAt, stores }, null, 2))
      return
    }
    const { lines, failures } = compare(baseline, stores, takenAt)
    console.log(lines.join('\n'))
    if (failures) process.exitCode = 1
  } finally {
    db.close()
  }
}

main().catch(error => {
  console.error(`multistore-baseline: ${error.message}`)
  process.exitCode = 2
})
