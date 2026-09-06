import 'dotenv/config';
import { PrismaClient, Prisma } from '@prisma/client';
import { transaction } from '../apps/api/src/core.js';
import { createBuild, reserveBuild } from '../apps/api/src/production.js';
const db = new PrismaClient();
if (process.env.ERP_TEST_MODE !== 'true') throw new Error('Demo seed is allowed only with ERP_TEST_MODE=true.');
const parts = [
  { category: 'CPU', code: 'TEST-CPU-7500F', name: 'Test · Ryzen 5 7500F', cost: 240, serial: true },
  { category: 'GPU', code: 'TEST-GPU-5060', name: 'Test · RTX 5060 8GB', cost: 600, serial: true },
  { category: 'RAM', code: 'TEST-RAM-32-6000', name: 'Test · 32GB DDR5-6000 kit', cost: 150, serial: false },
  { category: 'SSD', code: 'TEST-SSD-1TB', name: 'Test · 1TB NVMe SSD', cost: 90, serial: true },
  { category: 'MOTHERBOARD', code: 'TEST-MB-B850', name: 'Test · B850 WiFi motherboard', cost: 220, serial: true },
  { category: 'CASE', code: 'TEST-CASE', name: 'Test · Godmode case', cost: 80, serial: false },
  { category: 'PSU', code: 'TEST-PSU-750', name: 'Test · 750W Gold PSU', cost: 95, serial: false },
  { category: 'COOLER', code: 'TEST-COOLER', name: 'Test · Tower cooler', cost: 45, serial: false },
];
try {
  await transaction(db, async tx => {
    const loc = await tx.location.upsert({ where: { code: 'MAIN' }, update: {}, create: { code: 'MAIN', name: 'Main warehouse' } });
    await tx.location.upsert({ where: { code: 'QUARANTINE' }, update: {}, create: { code: 'QUARANTINE', name: 'Inspection shelf' } });
    const supplier = await tx.supplier.upsert({ where: { code: 'TEST-SUPPLIER' }, update: {}, create: { code: 'TEST-SUPPLIER', name: 'Demo supplier', notes: 'Sample supplier for testing only. No real orders are submitted.' } });
    const skus = [];
    for (const p of parts) {
      const family = await tx.componentFamily.upsert({ where: { name: `Test ${p.category}` }, update: {}, create: { name: `Test ${p.category}`, category: p.category } });
      const sku = await tx.sku.upsert({ where: { code: p.code }, update: {}, create: { code: p.code, name: p.name, familyId: family.id, trackingMode: p.serial ? 'SERIALIZED' : 'QUANTITY', attributes: { reorderPoint: 3 }, barcodes: { create: { value: p.code, isPrimary: true } } } }); skus.push(sku);
      const existing = await tx.inventoryTransaction.count({ where: { skuId: sku.id } });
      if (!existing) {
        await tx.inventoryTransaction.create({ data: { skuId: sku.id, locationId: loc.id, quantityDelta: 10, unitCost: new Prisma.Decimal(p.cost), type: 'PURCHASE_RECEIPT', referenceType: 'DEMO_SEED', referenceId: 'DEMO-1.0', createdBy: 'demo', reason: 'Illustrative test stock and cost' } });
        if (sku.trackingMode === 'SERIALIZED') for (let i = 1; i <= 10; i++) await tx.inventoryUnit.create({ data: { skuId: sku.id, locationId: loc.id, serialNumber: `${p.code}-SN-${String(i).padStart(3, '0')}`, unitCost: p.cost } });
      }
      await tx.supplierSku.upsert({ where: { supplierId_skuId: { supplierId: supplier.id, skuId: sku.id } }, update: {}, create: { supplierId: supplier.id, skuId: sku.id, unitCost: p.cost, currency: 'NZD', preferred: true, leadTimeDays: 3, minOrderQty: 1 } });
    }
    const product = await tx.product.upsert({ where: { code: 'TEST-COLOSSUS' }, update: {}, create: { code: 'TEST-COLOSSUS', name: 'Test Colossus' } });
    let bom = await tx.bomVersion.findFirst({ where: { productId: product.id }, orderBy: { version: 'desc' } });
    if (!bom) bom = await tx.bomVersion.create({ data: { productId: product.id, version: 1, lines: { create: parts.map((p, i) => ({ role: p.category, quantity: 1, lineType: 'EXACT_SKU', exactSkuId: skus[i].id })) } } });
    if (!await tx.shopifyProductMapping.findFirst({ where: { productId: product.id, sku: 'TEST-COLOSSUS' } })) await tx.shopifyProductMapping.create({ data: { sku: 'TEST-COLOSSUS', productId: product.id, priority: 1 } });
    for (const [index, state] of ['CREATED', 'RESERVED', 'IN_PROGRESS'].entries()) {
      const buildNumber = `TEST-DEMO-${index + 1}`;
      if (await tx.build.findUnique({ where: { buildNumber } })) continue;
      const build = await createBuild(tx, { buildNumber, productId: product.id, bomVersionId: bom.id });
      if (state !== 'CREATED') await reserveBuild(tx, build.id, loc.id);
      if (state === 'IN_PROGRESS') await tx.build.update({ where: { id: build.id }, data: { status: 'IN_PROGRESS', events: { create: { type: 'BUILD_STARTED', actor: 'demo' } } } });
    }
    if (!await tx.purchaseOrder.findUnique({ where: { number: 'TEST-DEMO-PO1' } })) await tx.purchaseOrder.create({ data: { number: 'TEST-DEMO-PO1', supplierId: supplier.id, status: 'ORDERED', orderedAt: new Date(), notes: 'Sample delivery for receiving tests', lines: { create: [{ skuId: skus[0].id, quantityOrdered: 3, unitCost: parts[0].cost }, { skuId: skus[2].id, quantityOrdered: 3, unitCost: parts[2].cost }] } } });
  });
  console.log('Test data ready: Test Colossus, components, supplier, a delivery and three production stages. Existing stock was preserved.');
} finally { await db.$disconnect(); }
