BEGIN;
-- AlterTable
ALTER TABLE "PurchaseOrder" ADD COLUMN     "costAllocation" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "freight" DECIMAL(12,2) DEFAULT 0,
ADD COLUMN     "fxConfirmed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "fxConfirmedBy" TEXT,
ADD COLUMN     "fxDate" DATE,
ADD COLUMN     "fxLockedAt" TIMESTAMP(3),
ADD COLUMN     "fxManual" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "fxNeedsReview" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "fxRate" DECIMAL(20,10),
ADD COLUMN     "fxRequestedDate" DATE,
ADD COLUMN     "fxSource" TEXT,
ADD COLUMN     "importCharges" DECIMAL(12,2) DEFAULT 0,
ADD COLUMN     "nzdSnapshot" JSONB,
ADD COLUMN     "orderDate" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "paymentFees" DECIMAL(12,2) DEFAULT 0,
ADD COLUMN     "tax" DECIMAL(12,2) DEFAULT 0,
ADD COLUMN     "total" DECIMAL(12,2),
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "PurchaseOrderLine" ADD COLUMN     "nzdLineTotal" DECIMAL(18,2),
ADD COLUMN     "nzdUnitCost" DECIMAL(20,8),
ADD COLUMN     "stockValueNzd" DECIMAL(18,2);

-- AlterTable
ALTER TABLE "InventoryUnit" ADD COLUMN     "nzdUnitCost" DECIMAL(20,8);

-- AlterTable
ALTER TABLE "InventoryTransaction" ADD COLUMN     "valuationNeedsReview" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "valueDeltaNzd" DECIMAL(18,2);

-- AlterTable
ALTER TABLE "UnitComponent" ADD COLUMN "nzdLineTotal" DECIMAL(18,2), ADD COLUMN     "nzdUnitCost" DECIMAL(20,8);

-- AlterTable
ALTER TABLE "SupplierInvoice" ADD COLUMN     "costAllocation" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "fxConfirmed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "fxConfirmedBy" TEXT,
ADD COLUMN     "fxDate" DATE,
ADD COLUMN     "fxLockedAt" TIMESTAMP(3),
ADD COLUMN     "fxManual" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "fxNeedsReview" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "fxRate" DECIMAL(20,10),
ADD COLUMN     "fxRequestedDate" DATE,
ADD COLUMN     "fxSource" TEXT,
ADD COLUMN     "importCharges" DECIMAL(12,2) DEFAULT 0,
ADD COLUMN     "nzdSnapshot" JSONB,
ADD COLUMN     "paymentFees" DECIMAL(12,2) DEFAULT 0;

-- AlterTable
ALTER TABLE "SupplierInvoiceLine" ADD COLUMN     "nzdLineTotal" DECIMAL(18,2),
ADD COLUMN     "nzdUnitCost" DECIMAL(20,8),
ADD COLUMN     "stockValueNzd" DECIMAL(18,2);

-- CreateTable
CREATE TABLE "InvoicePayment" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "amountNzd" DECIMAL(18,2) NOT NULL,
    "paidAt" DATE NOT NULL,
    "reference" TEXT NOT NULL,
    "recordedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoicePayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InvoicePayment_invoiceId_idx" ON "InvoicePayment"("invoiceId");

-- AddForeignKey
ALTER TABLE "InvoicePayment" ADD CONSTRAINT "InvoicePayment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "SupplierInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Preserve existing original amounts. Only NZD receives an identity rate.
UPDATE "SupplierInvoice" SET "fxRate"=1,"fxRequestedDate"="invoiceDate"::date,"fxDate"="invoiceDate"::date,"fxSource"='NZD base currency',"fxConfirmed"=true,"fxConfirmedBy"='migration',"fxNeedsReview"=false,
 "costAllocation"='{"freight":{"method":"EXPENSE"},"importCharges":{"method":"EXPENSE"},"paymentFees":{"method":"EXPENSE"}}'::jsonb WHERE currency='NZD';
UPDATE "PurchaseOrder" SET "orderDate"=COALESCE("orderedAt","createdAt")::date;
UPDATE "PurchaseOrder" SET "fxRate"=1,"fxRequestedDate"="orderDate","fxDate"="orderDate","fxSource"='NZD base currency',"fxConfirmed"=true,"fxConfirmedBy"='migration',"fxNeedsReview"=false WHERE currency='NZD';
-- Foreign records remain fxRate NULL, unconfirmed and marked for review.
-- Existing ledger rows are append-only: valuation code detects historical
-- foreign PO references and blocks valuation without editing any old movement.
ALTER TABLE "SupplierInvoice" ADD CONSTRAINT invoice_fx_positive CHECK ("fxRate" IS NULL OR ("fxRate">0 AND (currency<>'NZD' OR "fxRate"=1)));
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT po_fx_positive CHECK ("fxRate" IS NULL OR ("fxRate">0 AND (currency<>'NZD' OR "fxRate"=1)));
CREATE FUNCTION prevent_locked_fx_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD."fxLockedAt" IS NOT NULL AND
 (to_jsonb(OLD) - ARRAY['updatedAt','version','purchaseOrderId','status','orderedAt','notes','approvedBy','approvedAt','invoiceKey']) IS DISTINCT FROM
 (to_jsonb(NEW) - ARRAY['updatedAt','version','purchaseOrderId','status','orderedAt','notes','approvedBy','approvedAt','invoiceKey'])
 THEN RAISE EXCEPTION 'Approved currency, amounts and exchange rate are locked'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER invoice_fx_locked BEFORE UPDATE ON "SupplierInvoice" FOR EACH ROW EXECUTE FUNCTION prevent_locked_fx_change();
CREATE TRIGGER po_fx_locked BEFORE UPDATE ON "PurchaseOrder" FOR EACH ROW EXECUTE FUNCTION prevent_locked_fx_change();
CREATE FUNCTION prevent_locked_cost_line_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE locked timestamp;
BEGIN
 IF TG_TABLE_NAME='SupplierInvoiceLine' THEN SELECT "fxLockedAt" INTO locked FROM "SupplierInvoice" WHERE id=COALESCE(OLD."invoiceId",NEW."invoiceId");
 ELSE SELECT "fxLockedAt" INTO locked FROM "PurchaseOrder" WHERE id=COALESCE(OLD."purchaseOrderId",NEW."purchaseOrderId"); END IF;
 IF locked IS NOT NULL AND (TG_OP<>'UPDATE' OR
 (to_jsonb(OLD)-ARRAY['updatedAt','quantityReceived']) IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['updatedAt','quantityReceived']))
 THEN RAISE EXCEPTION 'Approved original and converted line costs are locked'; END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER invoice_cost_lines_locked BEFORE UPDATE OR DELETE OR INSERT ON "SupplierInvoiceLine" FOR EACH ROW EXECUTE FUNCTION prevent_locked_cost_line_change();
CREATE TRIGGER po_cost_lines_locked BEFORE UPDATE OR DELETE OR INSERT ON "PurchaseOrderLine" FOR EACH ROW EXECUTE FUNCTION prevent_locked_cost_line_change();
COMMIT;
