import type { FastifyInstance } from 'fastify';
import { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { actor, averageCost, ensure, mutate, position, type Tx } from './core.js';
const text = z.string().trim().min(1).max(200);
const serials = z.array(text).max(1000).default([]);

export async function receive(tx: Tx, b: { skuId: string; locationId: string; quantity: number; unitCost: number | Prisma.Decimal; serialNumbers: string[] }, who: string, reference?: string) {
  const sku = await tx.sku.findUniqueOrThrow({ where: { id: b.skuId } });
  ensure(sku.active, 'This SKU is inactive');
  ensure(sku.trackingMode === 'SERIALIZED' ? b.serialNumbers.length === b.quantity : b.serialNumbers.length === 0, 'Provide one serial per serialized item; quantity-only items do not accept serials', 400);
  ensure(new Set(b.serialNumbers).size === b.serialNumbers.length, 'Duplicate serial numbers', 400);
  const movement = await tx.inventoryTransaction.create({ data: { skuId: sku.id, locationId: b.locationId, quantityDelta: b.quantity, type: 'PURCHASE_RECEIPT', unitCost: new Prisma.Decimal(b.unitCost), referenceType: reference ? 'PURCHASE_ORDER' : 'MANUAL_RECEIPT', referenceId: reference, createdBy: who } });
  for (const serialNumber of b.serialNumbers) await tx.inventoryUnit.create({ data: { skuId: sku.id, locationId: b.locationId, serialNumber, unitCost: new Prisma.Decimal(b.unitCost) } });
  return movement;
}
export async function registerInventory(app: FastifyInstance, db: PrismaClient) {
  app.get('/catalog', async () => {
    const [families, skus, locations, products] = await Promise.all([
      db.componentFamily.findMany({ orderBy: { name: 'asc' } }), db.sku.findMany({ include: { family: true, barcodes: true }, orderBy: { name: 'asc' } }),
      db.location.findMany({ orderBy: { name: 'asc' } }), db.product.findMany({ where: { active: true }, include: { bomVersions: { orderBy: { version: 'desc' }, take: 1 } } }),
    ]); return { families, skus, locations, products };
  });
  app.post('/component-families', async q => { const b = z.object({ name: text, category: text }).parse(q.body); return mutate(db, q, 'Create component family', tx => tx.componentFamily.create({ data: b })); });
  app.post('/locations', async q => { const b = z.object({ code: text, name: text }).parse(q.body); return mutate(db, q, 'Create location', tx => tx.location.create({ data: b })); });
  app.post('/skus', async q => {
    const b = z.object({ code: text, name: text, familyId: text, trackingMode: z.enum(['QUANTITY', 'SERIALIZED']), barcodes: z.array(text).default([]), reorderPoint: z.number().int().nonnegative().default(0) }).parse(q.body);
    return mutate(db, q, 'Create SKU', tx => tx.sku.create({ data: { code: b.code, name: b.name, familyId: b.familyId, trackingMode: b.trackingMode, attributes: { reorderPoint: b.reorderPoint }, barcodes: { create: b.barcodes.map((value, i) => ({ value, isPrimary: i === 0 })) } } }));
  });
  app.patch('/skus/:id', async q => {
    const { id } = q.params as { id: string }; const b = z.object({ name: text.optional(), active: z.boolean().optional(), reorderPoint: z.number().int().nonnegative().optional(), barcode: text.optional() }).parse(q.body);
    return mutate(db, q, 'Update SKU', async tx => { const sku = await tx.sku.findUniqueOrThrow({ where: { id } }); if (b.barcode) await tx.skuBarcode.create({ data: { skuId: id, value: b.barcode } }); return tx.sku.update({ where: { id }, data: { name: b.name, active: b.active, attributes: b.reorderPoint === undefined ? undefined : { ...(sku.attributes as object ?? {}), reorderPoint: b.reorderPoint } } }); });
  });
  app.post('/skus/:skuId/barcodes', async q => { const { skuId } = q.params as { skuId: string }; const b = z.object({ value: text, isPrimary: z.boolean().default(false) }).parse(q.body); return mutate(db, q, 'Add barcode', async tx => { if (b.isPrimary) await tx.skuBarcode.updateMany({ where: { skuId }, data: { isPrimary: false } }); return tx.skuBarcode.create({ data: { skuId, ...b } }); }); });
  app.get('/barcodes/:value', async q => { const { value } = q.params as { value: string }; const result = await db.skuBarcode.findUnique({ where: { value }, include: { sku: true } }); ensure(result, 'Barcode not found', 404); return result; });
  app.get('/inventory', async () => {
    const [stock, reservations, skus, locations] = await Promise.all([
      db.inventoryTransaction.groupBy({ by: ['skuId', 'locationId'], _sum: { quantityDelta: true } }),
      db.inventoryReservation.groupBy({ by: ['skuId', 'locationId'], where: { status: 'ACTIVE' }, _sum: { quantity: true } }),
      db.sku.findMany({ where: { active: true }, include: { family: true, barcodes: true }, orderBy: { name: 'asc' } }), db.location.findMany(),
    ]);
    return skus.flatMap(sku => locations.map(location => { const onHand = stock.find(x => x.skuId === sku.id && x.locationId === location.id)?._sum.quantityDelta ?? 0, reserved = reservations.find(x => x.skuId === sku.id && x.locationId === location.id)?._sum.quantity ?? 0; return { skuId: sku.id, sku, locationId: location.id, location, onHand, reserved, available: onHand - reserved }; }));
  });
  app.get('/inventory/units', async q => {
    const p = z.object({ skuId: z.string().optional(), locationId: z.string().optional(), available: z.enum(['true', 'false']).optional() }).parse(q.query);
    return db.inventoryUnit.findMany({ where: { skuId: p.skuId, locationId: p.locationId, ...(p.available === 'true' ? { consumedAt: null, reservations: { none: { status: 'ACTIVE' as const } } } : {}) }, include: { sku: true, location: true, reservations: { where: { status: 'ACTIVE' }, include: { build: true } } }, orderBy: { receivedAt: 'desc' }, take: 2000 });
  });
  app.get('/inventory/movements', async () => db.inventoryTransaction.findMany({ include: { sku: true, location: true }, orderBy: { createdAt: 'desc' }, take: 1000 }));
  app.post('/inventory/receipts', async q => { const b = z.object({ skuId: text, locationId: text, quantity: z.number().int().positive().max(10000), unitCost: z.number().nonnegative(), serialNumbers: serials }).parse(q.body); return mutate(db, q, 'Receive stock', tx => receive(tx, b, actor(q))); });
  app.post('/inventory/transfers', async q => {
    const b = z.object({ skuId: text, fromLocationId: text, toLocationId: text, quantity: z.number().int().positive(), serialNumbers: serials, reason: text }).parse(q.body);
    return mutate(db, q, 'Transfer stock', async tx => {
      ensure(b.fromLocationId !== b.toLocationId, 'Choose different source and destination locations', 400);
      const sku = await tx.sku.findUniqueOrThrow({ where: { id: b.skuId } }); const p = await position(tx, sku.id, b.fromLocationId);
      ensure(p.available >= b.quantity, 'Insufficient unreserved stock');
      let cost = await averageCost(tx, sku.id, b.fromLocationId);
      if (sku.trackingMode === 'SERIALIZED') {
        ensure(b.serialNumbers.length === b.quantity && new Set(b.serialNumbers).size === b.quantity, 'Provide distinct serials matching the transfer quantity', 400);
        const units = await tx.inventoryUnit.findMany({ where: { skuId: sku.id, locationId: b.fromLocationId, consumedAt: null, serialNumber: { in: b.serialNumbers }, reservations: { none: { status: 'ACTIVE' } } } });
        ensure(units.length === b.quantity, 'A serial is unavailable at this location');
        cost = units.reduce((sum, u) => sum.add(u.unitCost ?? 0), new Prisma.Decimal(0)).div(units.length).toDecimalPlaces(2);
        await tx.inventoryUnit.updateMany({ where: { id: { in: units.map(u => u.id) } }, data: { locationId: b.toLocationId } });
      } else ensure(!b.serialNumbers.length, 'Quantity-only items do not accept serials', 400);
      const shared = { skuId: sku.id, unitCost: cost, reason: b.reason, createdBy: actor(q), referenceType: 'TRANSFER', referenceId: String(q.headers['idempotency-key']) };
      await tx.inventoryTransaction.create({ data: { ...shared, locationId: b.fromLocationId, type: 'TRANSFER_OUT', quantityDelta: -b.quantity } });
      return tx.inventoryTransaction.create({ data: { ...shared, locationId: b.toLocationId, type: 'TRANSFER_IN', quantityDelta: b.quantity } });
    });
  });
  app.post('/inventory/adjustments', async q => {
    const b = z.object({ skuId: text, locationId: text, quantityDelta: z.number().int().refine(n => n !== 0), unitCost: z.number().nonnegative().optional(), serialNumbers: serials, reason: text }).parse(q.body);
    return mutate(db, q, 'Adjust stock', async tx => {
      const sku = await tx.sku.findUniqueOrThrow({ where: { id: b.skuId } });
      const p = await position(tx, sku.id, b.locationId); ensure(p.available + b.quantityDelta >= 0, 'Adjustment would remove reserved stock or make stock negative');
      let cost = b.quantityDelta > 0 ? new Prisma.Decimal(b.unitCost ?? 0) : await averageCost(tx, sku.id, b.locationId);
      ensure(b.quantityDelta < 0 || b.unitCost !== undefined, 'Unit cost is required when adding stock', 400);
      if (sku.trackingMode === 'SERIALIZED') {
        ensure(b.serialNumbers.length === Math.abs(b.quantityDelta) && new Set(b.serialNumbers).size === b.serialNumbers.length, 'Serial count must match adjustment quantity', 400);
        if (b.quantityDelta > 0) for (const serialNumber of b.serialNumbers) await tx.inventoryUnit.create({ data: { skuId: sku.id, locationId: b.locationId, serialNumber, unitCost: cost } });
        else {
          const units = await tx.inventoryUnit.findMany({ where: { skuId: sku.id, locationId: b.locationId, serialNumber: { in: b.serialNumbers }, consumedAt: null, reservations: { none: { status: 'ACTIVE' } } } });
          ensure(units.length === -b.quantityDelta, 'A serial is reserved or unavailable');
          cost = units.reduce((sum, u) => sum.add(u.unitCost ?? 0), new Prisma.Decimal(0)).div(units.length).toDecimalPlaces(2);
          await tx.inventoryUnit.updateMany({ where: { id: { in: units.map(u => u.id) } }, data: { locationId: null, consumedAt: new Date() } });
        }
      } else ensure(!b.serialNumbers.length, 'Quantity-only items do not accept serials', 400);
      return tx.inventoryTransaction.create({ data: { skuId: sku.id, locationId: b.locationId, quantityDelta: b.quantityDelta, unitCost: cost, type: 'ADJUSTMENT', reason: b.reason, createdBy: actor(q) } });
    });
  });
}
