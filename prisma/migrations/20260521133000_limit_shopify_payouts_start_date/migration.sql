DELETE FROM "PayoutTransaction"
WHERE "payoutId" IN (
  SELECT "id" FROM "Payout" WHERE "date" < '2026-02-02'
);

DELETE FROM "Payout"
WHERE "date" < '2026-02-02';
