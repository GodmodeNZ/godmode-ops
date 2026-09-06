BEGIN;
-- CreateTable
CREATE TABLE "IntegrationConnection" (
    "provider" TEXT NOT NULL,
    "encrypted" TEXT NOT NULL,
    "metadata" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationConnection_pkey" PRIMARY KEY ("provider")
);

-- CreateTable
CREATE TABLE "ShopifyCatalogVariant" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productTitle" TEXT NOT NULL,
    "variantTitle" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "productType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "shopifySku" TEXT,
    "barcode" TEXT,
    "skuId" TEXT,
    "matchMethod" TEXT,
    "confirmedBy" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "present" BOOLEAN NOT NULL DEFAULT true,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopifyCatalogVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierAlias" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "skuId" TEXT NOT NULL,
    "confirmedBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierAlias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierInvoice" (
    "id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceRef" TEXT,
    "sender" TEXT,
    "subject" TEXT,
    "supplierId" TEXT,
    "invoiceNumber" TEXT,
    "invoiceKey" TEXT,
    "invoiceDate" TIMESTAMP(3),
    "dueDate" TIMESTAMP(3),
    "currency" TEXT NOT NULL DEFAULT 'NZD',
    "subtotal" DECIMAL(12,2),
    "tax" DECIMAL(12,2),
    "freight" DECIMAL(12,2),
    "total" DECIMAL(12,2),
    "status" TEXT NOT NULL DEFAULT 'REVIEW',
    "extractedText" TEXT NOT NULL,
    "extractionWarnings" JSONB NOT NULL,
    "purchaseOrderId" TEXT,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "SupplierInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierInvoiceLine" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "supplierCode" TEXT,
    "barcode" TEXT,
    "quantity" INTEGER,
    "unitCost" DECIMAL(12,2),
    "lineTotal" DECIMAL(12,2),
    "skuId" TEXT,
    "confirmed" BOOLEAN NOT NULL DEFAULT false,
    "matchReason" TEXT,
    "matchSnapshot" JSONB,

    CONSTRAINT "SupplierInvoiceLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceFile" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "data" BYTEA NOT NULL,

    CONSTRAINT "InvoiceFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ShopifyCatalogVariant_skuId_idx" ON "ShopifyCatalogVariant"("skuId");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyCatalogVariant_shopDomain_variantId_key" ON "ShopifyCatalogVariant"("shopDomain", "variantId");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierAlias_supplierId_kind_key_key" ON "SupplierAlias"("supplierId", "kind", "key");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierInvoice_fingerprint_key" ON "SupplierInvoice"("fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierInvoice_invoiceKey_key" ON "SupplierInvoice"("invoiceKey");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierInvoiceLine_invoiceId_position_key" ON "SupplierInvoiceLine"("invoiceId", "position");

-- AddForeignKey
ALTER TABLE "ShopifyCatalogVariant" ADD CONSTRAINT "ShopifyCatalogVariant_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "Sku"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierAlias" ADD CONSTRAINT "SupplierAlias_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierAlias" ADD CONSTRAINT "SupplierAlias_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "Sku"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierInvoice" ADD CONSTRAINT "SupplierInvoice_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierInvoice" ADD CONSTRAINT "SupplierInvoice_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierInvoiceLine" ADD CONSTRAINT "SupplierInvoiceLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "SupplierInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierInvoiceLine" ADD CONSTRAINT "SupplierInvoiceLine_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "Sku"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceFile" ADD CONSTRAINT "InvoiceFile_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "SupplierInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "SupplierAlias" ADD CONSTRAINT "alias_kind" CHECK ("kind" IN ('CODE','NAME'));
ALTER TABLE "SupplierInvoice" ADD CONSTRAINT "invoice_status" CHECK ("status" IN ('REVIEW','APPROVED'));
ALTER TABLE "SupplierInvoiceLine" ADD CONSTRAINT "invoice_line_numbers" CHECK (("quantity" IS NULL OR "quantity" > 0) AND ("unitCost" IS NULL OR "unitCost" >= 0) AND ("lineTotal" IS NULL OR "lineTotal" >= 0));
COMMIT;
