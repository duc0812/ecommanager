ALTER TABLE "AppUser" ADD COLUMN "permissions" TEXT NOT NULL DEFAULT '[]';

UPDATE "AppUser"
SET "permissions" = CASE "role"
  WHEN 'SUPERADMIN' THEN '["overview","shopify","meta_billing","other_bills","fulfillment_dashboard","fulfillment_crawler","fulfillment_orders","fulfillment_export","fulfillment_suppliers","fulfillment_mapping","tools_spy_idea","tools_resources","projects","setup_store","setup_meta","setup_projects","setup_hr","setup_users"]'
  WHEN 'ADMIN' THEN '["overview","shopify","meta_billing","other_bills","fulfillment_dashboard","fulfillment_crawler","fulfillment_orders","fulfillment_export","fulfillment_suppliers","fulfillment_mapping","tools_spy_idea","tools_resources","projects"]'
  WHEN 'SELLER' THEN '["projects"]'
  WHEN 'SUPPORT' THEN '["other_bills","fulfillment_dashboard","fulfillment_crawler","fulfillment_orders","fulfillment_export","fulfillment_suppliers","fulfillment_mapping"]'
  ELSE '[]'
END
WHERE "permissions" = '[]';
