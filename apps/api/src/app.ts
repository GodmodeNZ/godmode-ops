import Fastify from 'fastify';
import cors from '@fastify/cors';
import rawBody from 'fastify-raw-body';
import { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { DomainError, averageCost } from './core.js';
import { registerAuth } from './auth.js';
import { registerInventory } from './inventory.js';
import { registerProduction } from './production.js';
import { registerProcurementRoutes, purchasePlan } from './procurement.js';
import { registerIntegrations } from './integrations.js';
export async function buildApp(db: PrismaClient, logger = true) {
  const app = Fastify({ logger: logger ? { redact: ['req.headers.cookie', 'req.headers.authorization'] } : false, bodyLimit: 2 * 1024 * 1024 });
  app.setErrorHandler((error, _q, r) => {
    if (error instanceof z.ZodError) return r.code(400).send({ error: error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') });
    if (error instanceof DomainError) return r.code(error.statusCode).send({ error: error.message });
    if (error instanceof Prisma.PrismaClientKnownRequestError) { if (error.code === 'P2002') return r.code(409).send({ error: 'A record with this code, number or serial already exists' }); if (error.code === 'P2025') return r.code(404).send({ error: 'Record not found' }); if (error.code === 'P2003') return r.code(400).send({ error: 'A referenced record does not exist' }); }
    app.log.error(error); return r.code(500).send({ error: 'The request could not be completed. No partial transaction was saved.' });
  });
  app.get('/health', async (_q, r) => { try { await db.$queryRaw`SELECT 1`; return { ok: true, service: 'godmode-ops', version: '1.0.0' }; } catch { return r.code(503).send({ ok: false }); } });
  await app.register(async api => {
    await api.register(cors, { origin: process.env.WEB_ORIGIN ?? 'http://localhost:5173', credentials: true });
    await api.register(rawBody, { field: 'rawBody', global: false, encoding: false, runFirst: true });
    api.addHook('onRoute', options => { if (options.url.includes('/webhooks/')) options.config = { ...options.config, rawBody: true }; });
    await registerAuth(api, db); await registerInventory(api, db); await registerProduction(api, db); await registerProcurementRoutes(api, db); await registerIntegrations(api, db);
    api.get('/audit', async () => db.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 1000 }));
    api.get('/reports', async () => {
      const [skus, units, orders, plan] = await Promise.all([db.sku.findMany(), db.godmodeUnit.findMany({ include: { components: true, shipment: true, build: { include: { product: true } } } }), db.salesOrder.findMany({ include: { lines: true } }), purchasePlan(db)]);
      const stock = await db.inventoryTransaction.groupBy({ by: ['skuId'], _sum: { quantityDelta: true } });
      const valuation = await Promise.all(skus.map(async sku => { const qty = stock.find(s => s.skuId === sku.id)?._sum.quantityDelta ?? 0; const cost = await averageCost(db, sku.id); return { sku: sku.name, code: sku.code, quantity: qty, averageCost: cost, value: cost.mul(qty).toDecimalPlaces(2) }; }));
      return { valuation, inventoryValue: valuation.reduce((n, s) => n + Number(s.value), 0), finishedGoodsValue: units.filter(u => !u.shipment).reduce((n, u) => n + u.components.reduce((v, c) => v + Number(c.unitCost ?? 0) * c.quantity, 0), 0), buildCosts: units.map(u => ({ unitNumber: u.unitNumber, product: u.build.product.name, dispatched: Boolean(u.shipment), cost: u.components.reduce((n, c) => n + Number(c.unitCost ?? 0) * c.quantity, 0) })), openOrderValue: orders.filter(o => !['COMPLETED', 'CANCELLED'].includes(o.status)).reduce((n, o) => n + Number(o.total ?? 0), 0), shortageLines: plan.filter(p => p.shortage > 0).length };
    });
  }, { prefix: '/api' });
  return app;
}
