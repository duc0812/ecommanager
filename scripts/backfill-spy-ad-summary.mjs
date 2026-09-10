// One-off: fill SpyAd.firstCollationCount / everActive / observationCount from the
// SpyAdObservation history, so list endpoints no longer need to load every
// observation row per ad. Safe to re-run.
//
// Usage: node scripts/backfill-spy-ad-summary.mjs   (DATABASE_URL honoured, default file:./dev.db)
import { createClient } from '@libsql/client'

const url = process.env.DATABASE_URL || 'file:./dev.db'
const db = createClient({ url })

const rows = await db.execute(`
  SELECT adId,
         COUNT(*) AS n,
         MAX(isActive) AS everActive,
         (SELECT collationCount FROM SpyAdObservation o2 WHERE o2.adId = o.adId ORDER BY observedAt ASC, id ASC LIMIT 1) AS firstCollationCount
  FROM SpyAdObservation o
  GROUP BY adId
`)
console.log(`db=${url} ads with observations: ${rows.rows.length}`)
let updated = 0
for (const r of rows.rows) {
  const res = await db.execute({
    sql: 'UPDATE SpyAd SET observationCount = ?, everActive = ?, firstCollationCount = ? WHERE id = ?',
    args: [Number(r.n), Number(r.everActive) ? 1 : 0, r.firstCollationCount == null ? null : Number(r.firstCollationCount), r.adId],
  })
  updated += res.rowsAffected
}
const noObs = await db.execute('UPDATE SpyAd SET everActive = isActive, observationCount = 0 WHERE observationCount = 0 AND everActive = 0 AND isActive = 1')
console.log(`updated ${updated} ad(s); ${noObs.rowsAffected} ad(s) without observations marked from current isActive`)
