-- One numbering for an order's lines (owner 2026-10-29, LIT5092): a design task's key is the order's line key —
-- "<order>_<n>" with n counting product lines only, in Shopify order — the number the order page, the supplier CSV
-- and the tracking sheets already use. Tasks were keyed by Shopify line position, so an add-on line (Custom Text,
-- Tip, Shipping/Package Protection) ahead of the products shifted every task by one. Product-line rule = isNonProductLine.
CREATE TABLE "_TaskLineKey" AS
SELECT t."id" AS "taskId", t."taskKey" AS "oldKey", k."lineKey" AS "newKey"
FROM "DesignTask" t
JOIN (
    SELECT l."orderId", l."shopifyLineId",
           replace(o."shopifyOrderNumber", '#', '') || '_' || ROW_NUMBER() OVER (PARTITION BY l."orderId" ORDER BY l."linePosition") AS "lineKey"
    FROM "OrderLine" l
    JOIN "Order" o ON o."id" = l."orderId"
    WHERE lower(trim(coalesce(l."shopifyProductType", ''))) <> 'custom text'
      AND lower(trim(l."productTitle")) NOT IN ('custom text', 'tip', 'shipping protection', 'package protection')
) k ON k."orderId" = t."orderId" AND k."shopifyLineId" = t."shopifyLineId"
WHERE t."taskKey" <> k."lineKey";

INSERT INTO "DesignTaskEvent" ("id", "taskId", "type", "message")
SELECT 'tk' || lower(hex(randomblob(11))), "taskId", 'SYSTEM', 'Đổi mã task ' || "oldKey" || ' → ' || "newKey" || ' (theo mã line của đơn, bỏ dòng phí)'
FROM "_TaskLineKey";

-- Two passes: taskKey is unique and an order's old and new keys overlap (_2,_3 → _1,_2).
UPDATE "DesignTask" SET "taskKey" = '~' || "id" WHERE "id" IN (SELECT "taskId" FROM "_TaskLineKey");
UPDATE "DesignTask" SET "taskKey" = (SELECT "newKey" FROM "_TaskLineKey" WHERE "taskId" = "DesignTask"."id")
WHERE "id" IN (SELECT "taskId" FROM "_TaskLineKey");

DROP TABLE "_TaskLineKey";
