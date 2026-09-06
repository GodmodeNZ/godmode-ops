BEGIN;
-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'OPERATOR',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("tokenHash")
);

-- CreateTable
CREATE TABLE "Operation" (
    "key" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Operation_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "reference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shipment" (
    "id" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "carrier" TEXT NOT NULL,
    "trackingNumber" TEXT NOT NULL,
    "dispatchedBy" TEXT NOT NULL,
    "dispatchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Shipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RepairTicket" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "issue" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "resolution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RepairTicket_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Shipment_unitId_key" ON "Shipment"("unitId");

-- CreateIndex
CREATE UNIQUE INDEX "RepairTicket_number_key" ON "RepairTicket"("number");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "GodmodeUnit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepairTicket" ADD CONSTRAINT "RepairTicket_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "GodmodeUnit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- One physical component cannot be reserved by two active builds.
CREATE UNIQUE INDEX "InventoryReservation_one_active_serial" ON "InventoryReservation" ("inventoryUnitId") WHERE "status" = 'ACTIVE' AND "inventoryUnitId" IS NOT NULL;
ALTER TABLE "InventoryReservation" ADD CONSTRAINT "reservation_positive_quantity" CHECK (quantity > 0);
ALTER TABLE "InventoryReservation" ADD CONSTRAINT "serial_reservation_one_unit" CHECK ("inventoryUnitId" IS NULL OR quantity = 1);
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "po_receipt_bounds" CHECK ("quantityOrdered" > 0 AND "quantityReceived" >= 0 AND "quantityReceived" <= "quantityOrdered");
ALTER TABLE "BuildBomLine" ADD CONSTRAINT "build_line_positive_quantity" CHECK (quantity > 0);
ALTER TABLE "BomLine" ADD CONSTRAINT "bom_line_positive_quantity" CHECK (quantity > 0);
ALTER TABLE "User" ADD CONSTRAINT "user_valid_role" CHECK (role IN ('ADMIN','OPERATOR','VIEWER'));
ALTER TABLE "RepairTicket" ADD CONSTRAINT "repair_valid_status" CHECK (status IN ('OPEN','DIAGNOSING','REPAIRING','CLOSED'));

-- Corrections must be compensating entries, never edits to movement history.
CREATE FUNCTION prevent_inventory_ledger_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Inventory ledger is append-only. Post a compensating adjustment.'; END;
$$;
CREATE TRIGGER inventory_ledger_immutable BEFORE UPDATE OR DELETE ON "InventoryTransaction" FOR EACH ROW EXECUTE FUNCTION prevent_inventory_ledger_change();

COMMIT;
