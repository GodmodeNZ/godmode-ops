CREATE TABLE "CatalogueCandidate" (
 "id" TEXT PRIMARY KEY,
 "batch" TEXT NOT NULL,
 "sourceRow" INTEGER NOT NULL,
 "code" TEXT NOT NULL,
 "name" TEXT NOT NULL,
 "counted" BOOLEAN NOT NULL DEFAULT FALSE,
 "skuId" TEXT REFERENCES "Sku"("id"),
 "confirmedBy" TEXT,
 "confirmedAt" TIMESTAMP(3),
 "version" INTEGER NOT NULL DEFAULT 1,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE("batch","sourceRow")
);
CREATE INDEX "CatalogueCandidate_code_idx" ON "CatalogueCandidate"("code");
