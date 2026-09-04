import type { FastifyInstance } from 'fastify';
import { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { actor, averageCost, ensure, json, mutate, position, syncOrderStatuses, type Tx } from './core.js';
const text = z.string().trim().min(1).max(200);
const detail = { product: true, lines: true, reservations: { include: { sku: true, inventoryUnit: true } }, events: { orderBy: { createdAt: 'asc' as const } }, unit: { include: { shipment: true, components: { include: { sku: true } }, repairs: true } } };
export const qaChecks = ['hardware', 'memory', 'storage', 'thermals', 'windows', 'cosmetic'] as const;
export async function reserveBuild(tx: Tx, buildId: string, locationId: string) {
  const build = await tx.build.findUniqueOrThrow({ where: { id: buildId }, include: { lines: true } });
  ensure(['CREATED', 'RESERVED'].includes(build.status), 'Only a queued or reserved build can be reserved');
  ensure(build.lines.length, 'Build has no BOM lines');
  await tx.inventoryReservation.updateMany({ where: { buildId, status: 'ACTIVE' }, data: { status: 'RELEASED' } });
  for (const line of build.lines) {
    ensure(line.allocatedSkuId, `Choose an approved SKU for ${line.role}`);
    const sku = await tx.sku.findUniqueOrThrow({ where: { id: line.allocatedSkuId } }); ensure(sku.active, `${sku.name} is inactive`);
    ensure((await position(tx, sku.id, locationId)).available >= line.quantity, `Insufficient ${sku.name} for ${line.role}`);
    if (sku.trackingMode === 'SERIALIZED') {
      const units = await tx.inventoryUnit.findMany({ where: { skuId: sku.id, locationId, consumedAt: null, reservations: { none: { status: 'ACTIVE' } } }, orderBy: { receivedAt: 'asc' }, take: line.quantity });
      ensure(units.length === line.quantity, `Insufficient available serials for ${sku.name}`);
      for (const u of units) await tx.inventoryReservation.create({ data: { skuId: sku.id, locationId, buildId, buildLineId: line.id, inventoryUnitId: u.id, quantity: 1 } });
    } else await tx.inventoryReservation.create({ data: { skuId: sku.id, locationId, buildId, buildLineId: line.id, quantity: line.quantity } });
  }
  return tx.build.update({ where: { id: buildId }, data: { status: 'RESERVED', events: { create: { type: 'INVENTORY_RESERVED' } } } });
}
export async function createBuild(tx: Tx, b: { buildNumber: string; productId: string; bomVersionId: string; externalOrderId?: string }, overrides: Map<string, { skuId: string; quantity?: number }> = new Map()) {
  const bom = await tx.bomVersion.findUniqueOrThrow({ where: { id: b.bomVersionId }, include: { product: true, lines: { include: { approvedSkus: { orderBy: { priority: 'asc' } } } } } });
  ensure(bom.productId === b.productId && bom.active && bom.product.active, 'Choose an active BOM belonging to this product', 400);
  ensure(bom.lines.length, 'BOM must contain components', 400);
  return tx.build.create({ data: { ...b, lines: { create: bom.lines.map(l => { const o = overrides.get(l.role); return { role: l.role, quantity: o?.quantity ?? l.quantity, requestedSkuId: o?.skuId ?? l.exactSkuId, allocatedSkuId: o?.skuId ?? l.exactSkuId ?? l.approvedSkus[0]?.skuId, requirement: l.requirement ?? Prisma.JsonNull }; }) }, events: { create: { type: 'BUILD_CREATED' } } }, include: { lines: true } });
}
export async function registerProduction(app: FastifyInstance, db: PrismaClient) {
  app.get('/products', async () => db.product.findMany({ include: { bomVersions: { orderBy: { version: 'desc' }, include: { lines: { include: { exactSku: true, approvedSkus: { include: { sku: true } } } } } } }, orderBy: { name: 'asc' } }));
  app.post('/products', async q => { const b = z.object({ code: text, name: text }).parse(q.body); return mutate(db, q, 'Create product', tx => tx.product.create({ data: b })); });
  app.post('/products/:productId/bom-versions', async q => {
    const { productId } = q.params as { productId: string }; const b = z.object({ lines: z.array(z.object({ role: text, quantity: z.number().int().positive(), exactSkuId: text.optional(), approvedSkuIds: z.array(text).default([]), requirement: z.record(z.string(), z.unknown()).optional() })).min(1) }).parse(q.body);
    ensure(new Set(b.lines.map(l => l.role.toUpperCase())).size === b.lines.length, 'BOM roles must be unique', 400);
    ensure(b.lines.every(l => l.exactSkuId || l.approvedSkuIds.length), 'Each BOM line needs a SKU or approved alternatives', 400);
    return mutate(db, q, 'Create BOM version', async tx => {
      const latest = await tx.bomVersion.findFirst({ where: { productId }, orderBy: { version: 'desc' } });
      return tx.bomVersion.create({ data: { productId, version: (latest?.version ?? 0) + 1, lines: { create: b.lines.map(l => ({ role: l.role.toUpperCase(), quantity: l.quantity, lineType: l.exactSkuId ? 'EXACT_SKU' : 'REQUIREMENT', exactSkuId: l.exactSkuId, requirement: l.requirement ? json(l.requirement) : undefined, approvedSkus: { create: [...new Set(l.approvedSkuIds)].map((skuId, priority) => ({ skuId, priority })) } })) } } });
    });
  });
  app.get('/builds', async () => db.build.findMany({ include: detail, orderBy: { createdAt: 'desc' }, take: 2000 }));
  app.post('/builds', async q => { const b = z.object({ buildNumber: text, productId: text, bomVersionId: text, externalOrderId: text.optional() }).parse(q.body); return mutate(db, q, 'Create build', tx => createBuild(tx, b)); });
  app.post('/builds/:id/reserve', async q => { const { id } = q.params as { id: string }; const { locationId } = z.object({ locationId: text }).parse(q.body); return mutate(db, q, 'Reserve build', async tx => { const result = await reserveBuild(tx, id, locationId); await syncOrderStatuses(tx); return result; }); });
  app.post('/builds/:id/release', async q => { const { id } = q.params as { id: string }; return mutate(db, q, 'Release build reservation', async tx => { const b = await tx.build.findUniqueOrThrow({ where: { id } }); ensure(b.status === 'RESERVED', 'Only a reserved build can be released'); await tx.inventoryReservation.updateMany({ where: { buildId: id, status: 'ACTIVE' }, data: { status: 'RELEASED' } }); const result = await tx.build.update({ where: { id }, data: { status: 'CREATED', events: { create: { type: 'RESERVATIONS_RELEASED', actor: actor(q) } } } }); await syncOrderStatuses(tx); return result; }); });
  app.patch('/builds/:id/lines/:lineId', async q => {
    const { id, lineId } = q.params as { id: string; lineId: string }; const b = z.object({ skuId: text, reason: text }).parse(q.body);
    return mutate(db, q, 'Substitute build component', async tx => {
      const build = await tx.build.findUniqueOrThrow({ where: { id }, include: { lines: true, bomVersion: { include: { lines: { include: { approvedSkus: true } } } } } });
      ensure(build.status === 'CREATED', 'Release the reservation before changing components');
      const line = build.lines.find(l => l.id === lineId); ensure(line, 'Build line not found', 404);
      const template = build.bomVersion.lines.find(l => l.role === line.role);
      ensure(b.skuId === line.requestedSkuId || b.skuId === template?.exactSkuId || template?.approvedSkus.some(s => s.skuId === b.skuId), 'SKU is not an approved alternative in the snapshotted BOM');
      await tx.buildEvent.create({ data: { buildId: id, type: 'COMPONENT_SUBSTITUTED', actor: actor(q), metadata: { role: line.role, from: line.allocatedSkuId, to: b.skuId, reason: b.reason } } });
      return tx.buildBomLine.update({ where: { id: lineId }, data: { allocatedSkuId: b.skuId } });
    });
  });
  app.post('/builds/:id/start', async q => { const { id } = q.params as { id: string }; return mutate(db, q, 'Start build', async tx => { const b = await tx.build.findUniqueOrThrow({ where: { id } }); ensure(b.status === 'RESERVED', 'Reserve every component before starting'); const result = await tx.build.update({ where: { id }, data: { status: 'IN_PROGRESS', events: { create: { type: 'BUILD_STARTED', actor: actor(q) } } } }); await syncOrderStatuses(tx); return result; }); });
  app.post('/builds/:id/cancel', async q => { const { id } = q.params as { id: string }; const { reason } = z.object({ reason: text }).parse(q.body); return mutate(db, q, 'Cancel build', async tx => { const b = await tx.build.findUniqueOrThrow({ where: { id } }); ensure(['CREATED', 'RESERVED'].includes(b.status), 'Only unstarted builds can be cancelled'); await tx.inventoryReservation.updateMany({ where: { buildId: id, status: 'ACTIVE' }, data: { status: 'RELEASED' } }); const result = await tx.build.update({ where: { id }, data: { status: 'CANCELLED', events: { create: { type: 'BUILD_CANCELLED', actor: actor(q), metadata: { reason } } } } }); await syncOrderStatuses(tx); return result; }); });
  app.post('/builds/:id/qa', async q => {
    const { id } = q.params as { id: string }; const b = z.object({ checks: z.record(z.string(), z.boolean()), notes: z.string().max(4000).default('') }).parse(q.body);
    ensure(qaChecks.every(k => typeof b.checks[k] === 'boolean'), 'Record every QA check', 400);
    return mutate(db, q, 'Record QA', async tx => { const build = await tx.build.findUniqueOrThrow({ where: { id } }); ensure(build.status === 'IN_PROGRESS', 'QA is recorded for a build in progress'); return tx.buildEvent.create({ data: { buildId: id, type: 'QA_RECORDED', actor: actor(q), metadata: { ...b, passed: qaChecks.every(k => b.checks[k]) } } }); });
  });
  app.post('/builds/:id/complete', async q => {
    const { id } = q.params as { id: string }; const { unitNumber } = z.object({ unitNumber: text }).parse(q.body);
    return mutate(db, q, 'Complete build', async tx => {
      const b = await tx.build.findUniqueOrThrow({ where: { id }, include: { lines: true, reservations: { where: { status: 'ACTIVE' }, include: { inventoryUnit: true } }, events: { where: { type: 'QA_RECORDED' }, orderBy: { createdAt: 'desc' }, take: 1 } } });
      ensure(b.status === 'IN_PROGRESS', 'Start the build before completing it'); ensure((b.events[0]?.metadata as any)?.passed === true, 'All QA checks must pass before completion');
      ensure(b.lines.length && b.lines.every(l => b.reservations.filter(r => r.buildLineId === l.id && r.skuId === l.allocatedSkuId).reduce((n, r) => n + r.quantity, 0) === l.quantity), 'The build does not have complete component reservations');
      const unit = await tx.godmodeUnit.create({ data: { unitNumber, buildId: id, completedAt: new Date() } });
      for (const r of b.reservations) {
        if (r.inventoryUnit) ensure(!r.inventoryUnit.consumedAt && r.inventoryUnit.locationId === r.locationId && r.inventoryUnit.skuId === r.skuId, 'A reserved serial is no longer available');
        const cost = r.inventoryUnit?.unitCost ?? await averageCost(tx, r.skuId, r.locationId);
        await tx.inventoryTransaction.create({ data: { skuId: r.skuId, locationId: r.locationId, quantityDelta: -r.quantity, unitCost: cost, type: 'BUILD_CONSUMPTION', referenceType: 'BUILD', referenceId: id, createdBy: actor(q) } });
        if (r.inventoryUnitId) await tx.inventoryUnit.update({ where: { id: r.inventoryUnitId }, data: { consumedAt: new Date(), locationId: null } });
        await tx.inventoryReservation.update({ where: { id: r.id }, data: { status: 'CONSUMED' } });
        await tx.unitComponent.create({ data: { unitId: unit.id, skuId: r.skuId, inventoryUnitId: r.inventoryUnitId, role: b.lines.find(l => l.id === r.buildLineId)!.role, quantity: r.quantity, serialNumber: r.inventoryUnit?.serialNumber, unitCost: cost } });
      }
      await tx.build.update({ where: { id }, data: { status: 'COMPLETED', events: { create: { type: 'BUILD_COMPLETED', actor: actor(q), metadata: { unitNumber } } } } }); await syncOrderStatuses(tx); return unit;
    });
  });
  app.get('/units', async () => db.godmodeUnit.findMany({ include: { build: { include: { product: true, events: true } }, components: { include: { sku: true } }, shipment: true, repairs: true }, orderBy: { createdAt: 'desc' } }));
  app.get('/units/:unitNumber', async q => { const { unitNumber } = q.params as { unitNumber: string }; const u = await db.godmodeUnit.findUnique({ where: { unitNumber }, include: { build: { include: { product: true, events: true } }, components: { include: { sku: true, inventoryUnit: true } }, shipment: true, repairs: true } }); ensure(u, 'Unit not found', 404); return u; });
  app.post('/units/:id/dispatch', async q => { const { id } = q.params as { id: string }; const b = z.object({ carrier: text, trackingNumber: text }).parse(q.body); return mutate(db, q, 'Dispatch PC', async tx => { const u = await tx.godmodeUnit.findUniqueOrThrow({ where: { id }, include: { build: true, repairs: true } }); ensure(u.build.status === 'COMPLETED', 'Only completed PCs can be dispatched'); ensure(!u.repairs.some(r => r.status !== 'CLOSED'), 'Close the open service ticket before dispatch'); const linked = await tx.salesOrder.findMany({ where: { lines: { some: { buildIds: { has: u.buildId } } } } }); ensure(linked.every(o => o.status !== 'CANCELLED' && o.financialStatus === 'paid'), 'The linked order is cancelled or payment is no longer confirmed'); const unresolved = await tx.salesOrderLine.count({ where: { buildIds: { has: u.buildId }, status: { not: 'RESOLVED' } } }); ensure(!unresolved, 'Resolve the order change before dispatch'); const s = await tx.shipment.create({ data: { unitId: id, ...b, dispatchedBy: actor(q) } }); await tx.buildEvent.create({ data: { buildId: u.buildId, type: 'DISPATCHED', actor: actor(q), metadata: b } }); await syncOrderStatuses(tx); return s; }); });
  app.get('/repairs', async () => db.repairTicket.findMany({ include: { unit: { include: { build: { include: { product: true } } } } }, orderBy: { createdAt: 'desc' } }));
  app.post('/repairs', async q => { const b = z.object({ number: text, unitId: text, issue: z.string().trim().min(1).max(4000) }).parse(q.body); return mutate(db, q, 'Open service ticket', tx => tx.repairTicket.create({ data: b })); });
  app.patch('/repairs/:id', async q => { const { id } = q.params as { id: string }; const b = z.object({ status: z.enum(['OPEN', 'DIAGNOSING', 'REPAIRING', 'CLOSED']), resolution: z.string().max(4000).optional() }).parse(q.body); ensure(b.status !== 'CLOSED' || b.resolution?.trim(), 'Add a resolution before closing a service ticket', 400); return mutate(db, q, 'Update service ticket', tx => tx.repairTicket.update({ where: { id }, data: b })); });
  app.get('/factory/builds/ready', async () => db.build.findMany({ where: { status: { in: ['RESERVED', 'IN_PROGRESS'] } }, include: detail }));
  app.get('/factory/builds/:buildNumber', async q => { const { buildNumber } = q.params as { buildNumber: string }; return db.build.findUnique({ where: { buildNumber }, include: detail }); });
  app.post('/factory/builds/:buildNumber/hardware-report', async q => { const { buildNumber } = q.params as { buildNumber: string }; const b = z.object({ station: text.optional(), agentId: text.optional(), hardware: z.record(z.string(), z.unknown()), passed: z.boolean().optional() }).parse(q.body); return mutate(db, q, 'Record hardware report', async tx => { const build = await tx.build.findUniqueOrThrow({ where: { buildNumber } }); return tx.buildEvent.create({ data: { buildId: build.id, type: 'HARDWARE_REPORT', actor: actor(q), metadata: json(b) } }); }); });
  app.post('/factory/builds/:buildNumber/events', async q => { const { buildNumber } = q.params as { buildNumber: string }; const b = z.object({ type: z.enum(['DEPLOYMENT_STARTED', 'DEPLOYMENT_COMPLETED', 'DEPLOYMENT_FAILED', 'TEST_RESULT']), metadata: z.record(z.string(), z.unknown()).optional() }).parse(q.body); return mutate(db, q, 'Record factory event', async tx => { const build = await tx.build.findUniqueOrThrow({ where: { buildNumber } }); return tx.buildEvent.create({ data: { buildId: build.id, type: b.type, actor: actor(q), metadata: b.metadata ? json(b.metadata) : undefined } }); }); });
}
