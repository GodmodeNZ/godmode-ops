import type { FastifyInstance } from 'fastify';
import { PrismaClient, Prisma } from '@prisma/client';
import { z } from 'zod';
import { actor, ensure, mutate, type Tx } from './core.js';
import { receive } from './inventory.js';
const text = z.string().trim().min(1).max(200);
const poInclude = { supplier: true, lines: { include: { sku: true } } };
export async function purchasePlan(db: Tx | PrismaClient) {
  const [stock, reservations, incoming, drafts, builds, skus] = await Promise.all([
    db.inventoryTransaction.groupBy({ by: ['skuId'], _sum: { quantityDelta: true } }),
    db.inventoryReservation.groupBy({ by: ['skuId'], where: { status: 'ACTIVE' }, _sum: { quantity: true } }),
    db.purchaseOrderLine.groupBy({ by: ['skuId'], where: { purchaseOrder: { status: { in: ['ORDERED', 'PARTIALLY_RECEIVED'] } } }, _sum: { quantityOrdered: true, quantityReceived: true } }),
    db.purchaseOrderLine.groupBy({ by: ['skuId'], where: { purchaseOrder: { status: 'DRAFT' } }, _sum: { quantityOrdered: true } }),
    db.build.findMany({ where: { status: 'CREATED' }, include: { lines: true } }),
    db.sku.findMany({ where: { active: true }, include: { family: true, supplierSkus: { where: { supplier: { active: true } }, include: { supplier: true }, orderBy: [{ preferred: 'desc' }, { unitCost: 'asc' }] } } }),
  ]);
  return skus.map(sku => {
    const onHand = stock.find(x => x.skuId === sku.id)?._sum.quantityDelta ?? 0;
    const reserved = reservations.find(x => x.skuId === sku.id)?._sum.quantity ?? 0;
    const po = incoming.find(x => x.skuId === sku.id);
    const ordered = (po?._sum.quantityOrdered ?? 0) - (po?._sum.quantityReceived ?? 0);
    const draft = drafts.find(x => x.skuId === sku.id)?._sum.quantityOrdered ?? 0;
    const demand = builds.flatMap(b => b.lines).filter(l => l.allocatedSkuId === sku.id).reduce((n, l) => n + l.quantity, 0);
    const reorderPoint = Number((sku.attributes as any)?.reorderPoint ?? 0);
    const shortage = Math.max(0, demand + reorderPoint - (onHand - reserved + ordered));
    const toOrder = Math.max(0, shortage - draft);
    const preferredSupplier = sku.supplierSkus.find(s => s.unitCost !== null && s.currency === 'NZD') ?? null;
    return { sku, onHand, reserved, available: onHand - reserved, incoming: ordered, draft, demand, reorderPoint, shortage, toOrder, quantity: toOrder ? Math.max(toOrder, preferredSupplier?.minOrderQty ?? 1) : 0, preferredSupplier };
  }).filter(x => x.shortage > 0 || x.reorderPoint > 0 || x.demand > 0).sort((a, b) => b.shortage - a.shortage);
}
export async function registerProcurementRoutes(app: FastifyInstance, db: PrismaClient) {
  app.get('/suppliers', async () => db.supplier.findMany({ include: { supplierSkus: { include: { sku: true } } }, orderBy: { name: 'asc' } }));
  app.post('/suppliers', async q => { const b = z.object({ code: text, name: text, email: z.string().email().optional(), phone: z.string().optional(), website: z.string().url().optional(), accountNumber: z.string().optional(), notes: z.string().optional() }).parse(q.body); return mutate(db, q, 'Create supplier', tx => tx.supplier.create({ data: b })); });
  app.patch('/suppliers/:id', async q => { const { id } = q.params as { id: string }; const b = z.object({ name: text.optional(), email: z.string().email().optional(), phone: z.string().optional(), notes: z.string().optional(), active: z.boolean().optional() }).parse(q.body); return mutate(db, q, 'Update supplier', tx => tx.supplier.update({ where: { id }, data: b })); });
  app.put('/suppliers/:supplierId/skus/:skuId', async q => {
    const { supplierId, skuId } = q.params as { supplierId: string; skuId: string };
    const b = z.object({ supplierCode: z.string().optional(), unitCost: z.number().nonnegative(), currency: z.literal('NZD').default('NZD'), preferred: z.boolean().default(false), leadTimeDays: z.number().int().nonnegative().default(0), minOrderQty: z.number().int().positive().default(1) }).parse(q.body);
    return mutate(db, q, 'Update supplier quote', async tx => { if (b.preferred) await tx.supplierSku.updateMany({ where: { skuId }, data: { preferred: false } }); const data = { ...b, unitCost: new Prisma.Decimal(b.unitCost), lastQuotedAt: new Date() }; return tx.supplierSku.upsert({ where: { supplierId_skuId: { supplierId, skuId } }, create: { supplierId, skuId, ...data }, update: data }); });
  });
  app.get('/purchase-orders', async () => db.purchaseOrder.findMany({ include: poInclude, orderBy: { createdAt: 'desc' }, take: 2000 }));
  app.post('/purchase-orders', async q => {
    const b = z.object({ number: text, supplierId: text, currency: z.literal('NZD').default('NZD'), supplierRef: z.string().optional(), notes: z.string().optional(), expectedAt: z.string().datetime().optional(), lines: z.array(z.object({ skuId: text, supplierCode: z.string().optional(), quantityOrdered: z.number().int().positive(), unitCost: z.number().nonnegative() })).min(1) }).parse(q.body);
    return mutate(db, q, 'Create purchase order', tx => tx.purchaseOrder.create({ data: { ...b, expectedAt: b.expectedAt ? new Date(b.expectedAt) : undefined, lines: { create: b.lines.map(l => ({ ...l, unitCost: new Prisma.Decimal(l.unitCost) })) } }, include: poInclude }));
  });
  app.post('/purchase-orders/:id/order', async q => { const { id } = q.params as { id: string }; return mutate(db, q, 'Mark purchase order placed', async tx => { const po = await tx.purchaseOrder.findUniqueOrThrow({ where: { id } }); ensure(po.status === 'DRAFT', 'Only draft POs can be marked ordered'); return tx.purchaseOrder.update({ where: { id }, data: { status: 'ORDERED', orderedAt: new Date() }, include: poInclude }); }); });
  app.post('/purchase-orders/:id/cancel', async q => { const { id } = q.params as { id: string }; const { reason } = z.object({ reason: text }).parse(q.body); return mutate(db, q, 'Cancel remaining purchase order', async tx => { const po = await tx.purchaseOrder.findUniqueOrThrow({ where: { id } }); ensure(!['RECEIVED', 'CANCELLED'].includes(po.status), 'This PO is already closed'); return tx.purchaseOrder.update({ where: { id }, data: { status: 'CANCELLED', notes: `${po.notes ?? ''}\nCancelled remainder: ${reason}` }, include: poInclude }); }); });
  app.post('/purchase-orders/:id/receive', async q => {
    const { id } = q.params as { id: string }; const b = z.object({ locationId: text, lines: z.array(z.object({ lineId: text, quantity: z.number().int().positive(), serialNumbers: z.array(text).default([]) })).min(1) }).parse(q.body);
    ensure(new Set(b.lines.map(l => l.lineId)).size === b.lines.length, 'A PO line may only appear once per receipt', 400);
    return mutate(db, q, 'Receive purchase order', async tx => {
      const po = await tx.purchaseOrder.findUniqueOrThrow({ where: { id }, include: { lines: true } }); ensure(['ORDERED', 'PARTIALLY_RECEIVED'].includes(po.status), 'Mark the PO ordered before receiving it');
      for (const l of b.lines) {
        const line = po.lines.find(x => x.id === l.lineId); ensure(line, 'PO line not found', 400); ensure(l.quantity <= line.quantityOrdered - line.quantityReceived, 'Receipt exceeds the remaining PO quantity');
        await receive(tx, { skuId: line.skuId, locationId: b.locationId, quantity: l.quantity, serialNumbers: l.serialNumbers, unitCost: line.unitCost }, actor(q), po.id);
        await tx.purchaseOrderLine.update({ where: { id: line.id }, data: { quantityReceived: { increment: l.quantity } } });
      }
      const lines = await tx.purchaseOrderLine.findMany({ where: { purchaseOrderId: id } });
      return tx.purchaseOrder.update({ where: { id }, data: { status: lines.every(l => l.quantityReceived === l.quantityOrdered) ? 'RECEIVED' : 'PARTIALLY_RECEIVED' }, include: poInclude });
    });
  });
  app.get('/procurement/reorder', async () => purchasePlan(db));
  app.post('/procurement/plan', async q => mutate(db, q, 'Create purchasing drafts', tx => createPurchaseDrafts(tx)));
}

export async function createPurchaseDrafts(tx: Tx) {
    const plan = await purchasePlan(tx); const groups = new Map<string, typeof plan>();
    for (const row of plan) if (row.quantity && row.preferredSupplier) { const id = row.preferredSupplier.supplierId; groups.set(id, [...(groups.get(id) ?? []), row]); }
    const created = [];
    for (const [supplierId, lines] of groups) created.push(await tx.purchaseOrder.create({ data: { number: `PO-${Date.now()}-${created.length + 1}`, supplierId, notes: 'Created from shortages; place with supplier before marking ordered.', lines: { create: lines.map(l => ({ skuId: l.sku.id, quantityOrdered: l.quantity, unitCost: l.preferredSupplier!.unitCost!, supplierCode: l.preferredSupplier!.supplierCode })) } }, include: poInclude }));
    return { created, missingQuotes: plan.filter(x => x.toOrder && !x.preferredSupplier).map(x => x.sku.name) };
}
