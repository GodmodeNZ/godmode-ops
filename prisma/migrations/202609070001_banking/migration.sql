BEGIN;
-- AlterTable
ALTER TABLE "InvoicePayment" ADD COLUMN     "bankAllocationId" TEXT,
ADD COLUMN     "reversalReason" TEXT,
ADD COLUMN     "reversedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "BankFeed" (
    "id" TEXT NOT NULL DEFAULT 'akahu',
    "version" INTEGER NOT NULL DEFAULT 1,
    "mode" TEXT NOT NULL DEFAULT 'SANDBOX',
    "status" TEXT NOT NULL DEFAULT 'UNCONFIGURED',
    "since" DATE NOT NULL,
    "autoSync" BOOLEAN NOT NULL DEFAULT false,
    "lastSyncAt" TIMESTAMP(3),
    "lastRefreshAttempt" TIMESTAMP(3),
    "nextRequestAt" TIMESTAMP(3),
    "error" TEXT,
    "leaseOwner" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BankFeed_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankOAuthState" (
    "hash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "configVersion" INTEGER NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankOAuthState_pkey" PRIMARY KEY ("hash")
);

-- CreateTable
CREATE TABLE "BankAccount" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "institution" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "maskedNumber" TEXT,
    "status" TEXT NOT NULL,
    "eligible" BOOLEAN NOT NULL DEFAULT false,
    "selected" BOOLEAN NOT NULL DEFAULT false,
    "refreshedAt" TIMESTAMP(3),
    "authorisationId" TEXT,
    "predecessorId" TEXT,
    "pending" JSONB NOT NULL DEFAULT '[]',
    "pendingAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BankAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankSync" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "accountIds" JSONB NOT NULL,
    "accountIndex" INTEGER NOT NULL DEFAULT 0,
    "cursor" TEXT,
    "start" TIMESTAMP(3) NOT NULL,
    "end" TIMESTAMP(3) NOT NULL,
    "pages" INTEGER NOT NULL DEFAULT 0,
    "imported" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "BankSync_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankTransaction" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "description" TEXT NOT NULL,
    "references" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'POSTED',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "reviewRequired" BOOLEAN NOT NULL DEFAULT false,
    "seenSync" TEXT,
    "providerUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BankTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankAllocation" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "invoiceCurrency" TEXT NOT NULL,
    "originalAmount" DECIMAL(18,2) NOT NULL,
    "amountNzd" DECIMAL(18,2) NOT NULL,
    "feeNzd" DECIMAL(18,2) NOT NULL,
    "approvedRate" DECIMAL(20,10),
    "expectedNzd" DECIMAL(18,2),
    "exchangeDifferenceNzd" DECIMAL(18,2),
    "evidence" JSONB NOT NULL,
    "confirmedBy" TEXT NOT NULL,
    "confirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversedAt" TIMESTAMP(3),
    "reversedBy" TEXT,
    "reversalReason" TEXT,

    CONSTRAINT "BankAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BankTransaction_accountId_date_idx" ON "BankTransaction"("accountId", "date");

-- CreateIndex
CREATE INDEX "BankAllocation_transactionId_reversedAt_idx" ON "BankAllocation"("transactionId", "reversedAt");

-- CreateIndex
CREATE INDEX "BankAllocation_invoiceId_reversedAt_idx" ON "BankAllocation"("invoiceId", "reversedAt");

-- CreateIndex
CREATE UNIQUE INDEX "InvoicePayment_bankAllocationId_key" ON "InvoicePayment"("bankAllocationId");

-- AddForeignKey
ALTER TABLE "InvoicePayment" ADD CONSTRAINT "InvoicePayment_bankAllocationId_fkey" FOREIGN KEY ("bankAllocationId") REFERENCES "BankAllocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "BankAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankAllocation" ADD CONSTRAINT "BankAllocation_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "BankTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankAllocation" ADD CONSTRAINT "BankAllocation_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "SupplierInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "BankAllocation" ADD CONSTRAINT bank_allocation_positive CHECK (
 "originalAmount">=0 AND "amountNzd">=0 AND "feeNzd">=0 AND "amountNzd"+"feeNzd">0
 AND (("originalAmount">0 AND "amountNzd">0) OR ("originalAmount"=0 AND "amountNzd"=0)));
CREATE FUNCTION bank_allocation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE debit numeric; used numeric; state text; curr text;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Bank allocations are retained for audit; reverse instead'; END IF;
 IF TG_OP='UPDATE' THEN
  IF OLD."reversedAt" IS NOT NULL OR NEW."reversedAt" IS NULL OR NEW."reversalReason" IS NULL OR NEW."reversedBy" IS NULL OR
   (to_jsonb(OLD)-ARRAY['reversedAt','reversedBy','reversalReason']) IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['reversedAt','reversedBy','reversalReason'])
  THEN RAISE EXCEPTION 'Bank allocations are immutable except for an audited reversal'; END IF;
  RETURN NEW;
 END IF;
 SELECT -amount,status,currency INTO debit,state,curr FROM "BankTransaction" WHERE id=NEW."transactionId" FOR UPDATE;
 SELECT COALESCE(SUM("amountNzd"+"feeNzd"),0) INTO used FROM "BankAllocation" WHERE "transactionId"=NEW."transactionId" AND "reversedAt" IS NULL;
 IF state<>'POSTED' OR curr<>'NZD' OR debit<=0 OR used+NEW."amountNzd"+NEW."feeNzd">debit THEN RAISE EXCEPTION 'Bank debit allocation exceeds available posted NZD funds'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bank_allocation_integrity BEFORE INSERT OR UPDATE OR DELETE ON "BankAllocation" FOR EACH ROW EXECUTE FUNCTION bank_allocation_guard();
CREATE FUNCTION bank_invoice_basis_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (OLD.currency IS DISTINCT FROM NEW.currency OR OLD.total IS DISTINCT FROM NEW.total)
 AND EXISTS (SELECT 1 FROM "BankAllocation" WHERE "invoiceId"=OLD.id AND "reversedAt" IS NULL)
 THEN RAISE EXCEPTION 'Reverse bank allocations before changing original invoice currency or total'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bank_invoice_basis_locked BEFORE UPDATE ON "SupplierInvoice" FOR EACH ROW EXECUTE FUNCTION bank_invoice_basis_guard();
COMMIT;
