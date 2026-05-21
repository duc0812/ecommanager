WITH numbered AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY orderId ORDER BY rowid) AS rn
  FROM "OrderLine"
)
UPDATE "OrderLine"
SET "linePosition" = (
  SELECT rn FROM numbered WHERE numbered.id = "OrderLine"."id"
);
