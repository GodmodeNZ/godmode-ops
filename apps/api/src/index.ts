import Fastify from 'fastify';
import cors from '@fastify/cors';
import { PrismaClient, Prisma, ReservationStatus, BuildStatus, TrackingMode } from '@prisma/client';
import { z } from 'zod';

const prisma = new PrismaClient();
const app = Fastify({ logger: true });
await app.register(cors, { origin: true });
const jsonRecord = z.record(z.string(), z.any());
const money = (value?: number) => value === undefined ? undefined : new Prisma.Decimal(value);
app.setErrorHandler((error, _request, reply) => reply.code(error instanceof z.ZodError ? 400 : 500).send({ error: error.message }));

app.get('/health', async () => ({ ok: true, service: 'godmode-ops-api', milestone: 'M2' }));
app.get('/catalog', async () => {
  const [families, skus, locations, products] = await Promise.all([
    prisma.componentFamily.findMany({ orderBy: [{ category: 'asc' }, { name: 'asc' }] }),
    prisma.sku.findMany({ where: { active: true }, include: { family: true, barcodes: true }, orderBy: { name: 'asc' } }),
    prisma.location.findMany({ orderBy: { name: 'asc' } }),
    prisma.product.findMany({ where: { active: true }, include: { bomVersions: { orderBy: { version: 'desc' }, take: 1 } }, orderBy: { name: 'asc' } })
  ]);
  return { families, skus, locations, products };
});
app.post('/component-families', async (req, reply) => {
  const body = z.object({ name: z.string().min(1), category: z.string().min(1), attributes: jsonRecord.optional() }).parse(req.body);
  return reply.code(201).send(await prisma.componentFamily.create({ data: body }));
});
app.post('/skus', async (req, reply) => {
  const body = z.object({ code: z.string().min(1), name: z.string().min(1), familyId: z.string(), trackingMode: z.enum(['QUANTITY', 'SERIALIZED']).default('QUANTITY'), attributes: jsonRecord.optional(), barcodes: z.array(z.string().min(1)).default([]) }).parse(req.body);
  return reply.code(201).send(await prisma.sku.create({ data: { code: body.code, name: body.name, familyId: body.familyId, trackingMode: body.trackingMode, attributes: body.attributes, barcodes: body.barcodes.length ? { create: body.barcodes.map((value, index) => ({ value, isPrimary: index === 0 })) } : undefined }, include: { family: true, barcodes: true } }));
});
app.post('/skus/:skuId/barcodes', async (req, reply) => {
  const { skuId } = z.object({ skuId: z.string() }).parse(req.params);
  const body = z.object({ value: z.string().min(1), kind: z.string().optional(), isPrimary: z.boolean().default(false) }).parse(req.body);
  if (body.isPrimary) await prisma.skuBarcode.updateMany({ where: { skuId }, data: { isPrimary: false } });
  return reply.code(201).send(await prisma.skuBarcode.create({ data: { skuId, ...body } }));
});
app.get('/barcodes/:value', async (req, reply) => {
  const { value } = z.object({ value: z.string().min(1) }).parse(req.params);
  const barcode = await prisma.skuBarcode.findUnique({ where: { value }, include: { sku: { include: { family: true, barcodes: true } } } });
  return barcode ?? reply.code(404).send({ error: 'Barcode not found' });
});
app.post('/locations', async (req, reply) => {
  const body = z.object({ code: z.string().min(1), name: z.string().min(1) }).parse(req.body);
  return reply.code(201).send(await prisma.location.create({ data: body }));
});
app.post('/inventory/receipts', async (req, reply) => {
  const body = z.object({ skuId: z.string(), locationId: z.string(), quantity: z.number().int().positive().default(1), unitCost: z.number().nonnegative().optional(), referenceId: z.string().optional(), createdBy: z.string().optional(), serialNumbers: z.array(z.string().min(1)).default([]) }).parse(req.body);
  const sku = await prisma.sku.findUniqueOrThrow({ where: { id: body.skuId } });
  if (sku.trackingMode === TrackingMode.SERIALIZED && body.serialNumbers.length !== body.quantity) return reply.code(400).send({ error: `Serialized SKU requires ${body.quantity} unique serial number(s)` });
  if (new Set(body.serialNumbers).size !== body.serialNumbers.length) return reply.code(400).send({ error: 'Duplicate serial numbers in receipt' });
  const result = await prisma.$transaction(async tx => {
    const transaction = await tx.inventoryTransaction.create({ data: { skuId: body.skuId, locationId: body.locationId, quantityDelta: body.quantity, type: 'PURCHASE_RECEIPT', referenceType: body.referenceId ? 'PURCHASE_ORDER' : undefined, referenceId: body.referenceId, unitCost: money(body.unitCost), createdBy: body.createdBy } });
    const units = sku.trackingMode === TrackingMode.SERIALIZED ? await Promise.all(body.serialNumbers.map(serialNumber => tx.inventoryUnit.create({ data: { skuId: body.skuId, locationId: body.locationId, serialNumber, unitCost: money(body.unitCost) } }))) : [];
    return { transaction, units };
  });
  return reply.code(201).send(result);
});
app.get('/inventory', async () => {
  const [stock, reserved, skus, locations] = await Promise.all([
    prisma.inventoryTransaction.groupBy({ by: ['skuId', 'locationId'], _sum: { quantityDelta: true } }),
    prisma.inventoryReservation.groupBy({ by: ['skuId', 'locationId'], where: { status: ReservationStatus.ACTIVE }, _sum: { quantity: true } }),
    prisma.sku.findMany({ include: { family: true, barcodes: true } }), prisma.location.findMany()
  ]);
  const skuMap = new Map(skus.map(s => [s.id, s])); const locationMap = new Map(locations.map(l => [l.id, l]));
  return stock.map(s => { const r = reserved.find(x => x.skuId === s.skuId && x.locationId === s.locationId)?._sum.quantity ?? 0; const onHand = s._sum.quantityDelta ?? 0; return { skuId: s.skuId, sku: skuMap.get(s.skuId), locationId: s.locationId, location: locationMap.get(s.locationId), onHand, reserved: r, available: onHand - r }; });
});
app.get('/inventory/units', async req => {
  const query = z.object({ skuId: z.string().optional(), locationId: z.string().optional(), available: z.coerce.boolean().optional() }).parse(req.query);
  return prisma.inventoryUnit.findMany({ where: { skuId: query.skuId, locationId: query.locationId, consumedAt: query.available ? null : undefined, reservations: query.available ? { none: { status: ReservationStatus.ACTIVE } } : undefined }, include: { sku: { include: { family: true } }, location: true, reservations: { where: { status: ReservationStatus.ACTIVE }, include: { build: true } } }, orderBy: { receivedAt: 'asc' } });
});
app.get('/inventory/movements', async () => prisma.inventoryTransaction.findMany({ include: { sku: true, location: true }, orderBy: { createdAt: 'desc' }, take: 200 }));
app.post('/products', async (req, reply) => { const body = z.object({ code: z.string().min(1), name: z.string().min(1) }).parse(req.body); return reply.code(201).send(await prisma.product.create({ data: body })); });
app.get('/products', async () => prisma.product.findMany({ include: { bomVersions: { orderBy: { version: 'desc' }, include: { lines: { include: { exactSku: true, approvedSkus: { include: { sku: true }, orderBy: { priority: 'asc' } } } } } } }, orderBy: { name: 'asc' } }));
app.post('/products/:productId/bom-versions', async (req, reply) => {
  const { productId } = z.object({ productId: z.string() }).parse(req.params);
  const body = z.object({ lines: z.array(z.object({ role: z.string().min(1), quantity: z.number().int().positive(), exactSkuId: z.string().optional(), requirement: jsonRecord.optional(), approvedSkuIds: z.array(z.string()).optional() })).min(1) }).parse(req.body);
  const latest = await prisma.bomVersion.findFirst({ where: { productId }, orderBy: { version: 'desc' } });
  return reply.code(201).send(await prisma.bomVersion.create({ data: { productId, version: (latest?.version ?? 0) + 1, lines: { create: body.lines.map(line => ({ role: line.role, quantity: line.quantity, lineType: line.exactSkuId ? 'EXACT_SKU' : 'REQUIREMENT', exactSkuId: line.exactSkuId, requirement: line.requirement, approvedSkus: line.approvedSkuIds?.length ? { create: line.approvedSkuIds.map((skuId, index) => ({ skuId, priority: index + 1 })) } : undefined })) } }, include: { lines: { include: { exactSku: true, approvedSkus: { include: { sku: true } } } } } }));
});
app.post('/builds', async (req, reply) => {
  const body = z.object({ buildNumber: z.string(), productId: z.string(), bomVersionId: z.string(), externalOrderId: z.string().optional() }).parse(req.body);
  const bom = await prisma.bomVersion.findUniqueOrThrow({ where: { id: body.bomVersionId }, include: { lines: { include: { approvedSkus: { orderBy: { priority: 'asc' } } } } } });
  return reply.code(201).send(await prisma.build.create({ data: { ...body, lines: { create: bom.lines.map(line => ({ role: line.role, quantity: line.quantity, requestedSkuId: line.exactSkuId, requirement: line.requirement, allocatedSkuId: line.exactSkuId ?? line.approvedSkus[0]?.skuId })) }, events: { create: { type: 'BUILD_CREATED' } } }, include: { lines: true } }));
});
app.post('/builds/:buildId/reserve', async (req, reply) => {
  const { buildId } = z.object({ buildId: z.string() }).parse(req.params); const { locationId } = z.object({ locationId: z.string() }).parse(req.body);
  const result = await prisma.$transaction(async tx => {
    const build = await tx.build.findUniqueOrThrow({ where: { id: buildId }, include: { lines: true } });
    if (![BuildStatus.CREATED, BuildStatus.RESERVED].includes(build.status)) throw new Error('Build is not reservable');
    await tx.inventoryReservation.updateMany({ where: { buildId, status: ReservationStatus.ACTIVE }, data: { status: ReservationStatus.RELEASED } });
    for (const line of build.lines) {
      if (!line.allocatedSkuId) throw new Error(`No allocated SKU for ${line.role}`); const sku = await tx.sku.findUniqueOrThrow({ where: { id: line.allocatedSkuId } });
      if (sku.trackingMode === TrackingMode.SERIALIZED) {
        const units = await tx.inventoryUnit.findMany({ where: { skuId: sku.id, locationId, consumedAt: null, reservations: { none: { status: ReservationStatus.ACTIVE } } }, orderBy: { receivedAt: 'asc' }, take: line.quantity });
        if (units.length < line.quantity) throw new Error(`Insufficient serialized stock for ${line.role}`);
        for (const unit of units) await tx.inventoryReservation.create({ data: { skuId: sku.id, locationId, buildId, buildLineId: line.id, inventoryUnitId: unit.id, quantity: 1 } });
      } else {
        const onHand = (await tx.inventoryTransaction.aggregate({ where: { skuId: sku.id, locationId }, _sum: { quantityDelta: true } }))._sum.quantityDelta ?? 0;
        const reserved = (await tx.inventoryReservation.aggregate({ where: { skuId: sku.id, locationId, status: ReservationStatus.ACTIVE }, _sum: { quantity: true } }))._sum.quantity ?? 0;
        if (onHand - reserved < line.quantity) throw new Error(`Insufficient available stock for ${line.role}`);
        await tx.inventoryReservation.create({ data: { skuId: sku.id, locationId, buildId, buildLineId: line.id, quantity: line.quantity } });
      }
    }
    await tx.build.update({ where: { id: buildId }, data: { status: BuildStatus.RESERVED, events: { create: { type: 'INVENTORY_RESERVED' } } } });
    return tx.build.findUnique({ where: { id: buildId }, include: { lines: true, reservations: { include: { inventoryUnit: true, sku: true } }, events: true } });
  }); return reply.send(result);
});
app.post('/builds/:buildId/start', async (req, reply) => {
  const { buildId } = z.object({ buildId: z.string() }).parse(req.params); const body = z.object({ actor: z.string().optional(), station: z.string().optional() }).parse(req.body ?? {});
  const build = await prisma.build.findUniqueOrThrow({ where: { id: buildId } }); if (build.status !== BuildStatus.RESERVED) return reply.code(409).send({ error: 'Build must be reserved before starting' });
  return prisma.build.update({ where: { id: buildId }, data: { status: BuildStatus.IN_PROGRESS, events: { create: { type: 'BUILD_STARTED', actor: body.actor, metadata: body.station ? { station: body.station } : undefined } } } });
});
app.post('/builds/:buildId/complete', async (req, reply) => {
  const { buildId } = z.object({ buildId: z.string() }).parse(req.params); const body = z.object({ unitNumber: z.string().min(1), actor: z.string().optional() }).parse(req.body);
  const unit = await prisma.$transaction(async tx => {
    const build = await tx.build.findUniqueOrThrow({ where: { id: buildId }, include: { lines: true, reservations: { where: { status: ReservationStatus.ACTIVE }, include: { inventoryUnit: true } } } });
    if (![BuildStatus.RESERVED, BuildStatus.IN_PROGRESS].includes(build.status)) throw new Error('Build must be reserved or in progress before completion');
    for (const r of build.reservations) { await tx.inventoryTransaction.create({ data: { skuId: r.skuId, locationId: r.locationId, quantityDelta: -r.quantity, type: 'BUILD_CONSUMPTION', referenceType: 'BUILD', referenceId: build.id, createdBy: body.actor } }); if (r.inventoryUnitId) await tx.inventoryUnit.update({ where: { id: r.inventoryUnitId }, data: { consumedAt: new Date(), locationId: null } }); await tx.inventoryReservation.update({ where: { id: r.id }, data: { status: ReservationStatus.CONSUMED } }); }
    const components = build.lines.flatMap(line => { const rs = build.reservations.filter(r => r.buildLineId === line.id); return rs.some(r => r.inventoryUnit) ? rs.map(r => ({ skuId: r.skuId, inventoryUnitId: r.inventoryUnitId, role: line.role, quantity: 1, serialNumber: r.inventoryUnit?.serialNumber, unitCost: r.inventoryUnit?.unitCost })) : line.allocatedSkuId ? [{ skuId: line.allocatedSkuId, role: line.role, quantity: line.quantity }] : []; });
    const created = await tx.godmodeUnit.create({ data: { unitNumber: body.unitNumber, buildId: build.id, completedAt: new Date(), components: { create: components } }, include: { components: { include: { sku: true, inventoryUnit: true } } } });
    await tx.build.update({ where: { id: build.id }, data: { status: BuildStatus.COMPLETED, events: { create: { type: 'BUILD_COMPLETED', actor: body.actor, metadata: { unitNumber: body.unitNumber } } } } }); return created;
  }); return reply.send(unit);
});
