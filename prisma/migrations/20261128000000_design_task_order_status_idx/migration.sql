-- "Duyệt sản xuất" asks for orders with a DONE task; without this index SQLite walked every DONE task per order.
CREATE INDEX "DesignTask_orderId_status_idx" ON "DesignTask"("orderId", "status");
