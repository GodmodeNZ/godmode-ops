import { registerBanking } from './banking.js';
import { registerComponentReview } from './component-review.js';
import {costReports} from './cost-reports.js';
import { registerFx } from './fx-routes.js';
import { registerMatching } from './matching.js';
import { registerInvoices } from './invoices.js';
import { registerMailbox } from './mailbox.js';
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
  const app = Fastify({ logger: logger ? { redact: ['req.headers.cookie', 'req.headers.authorization', 'req.url'] } : false, bodyLimit: 2 * 1024 * 1024 });
  app.setErrorHandler((error, _q, r) => {
    if (error instanceof z.ZodError) return r.code(400).send({ error: error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') });
    if (error instanceof DomainError) return r.code(error.statusCode).send({ error: error.message });
    if (error instanceof Prisma.PrismaClientKnownRequestError) { if (error.code === 'P2002') return r.code(409).send({ error: 'A record with this code, number or serial already exists' }); if (error.code === 'P2025') return r.code(404).send({ error: 'Record not found' }); if (error.code === 'P2003') return r.code(400).send({ error: 'A referenced record does not exist' }); }
    if (_q.url.startsWith('/api/banking')) app.log.error({ message: 'Banking operation failed', type: error instanceof Error ? error.name : 'Unknown' }); else app.log.error(error); return r.code(500).send({ error: 'The request could not be completed. No partial transaction was saved.' });
  });
  app.get('/health', async (_q, r) => { try { await db.$queryRaw`SELECT 1`; return { ok: true, service: 'godmode-ops', version: '1.0.0' }; } catch { return r.code(503).send({ ok: false }); } });
  await app.register(async api => {
    await api.register(cors, { origin: process.env.WEB_ORIGIN ?? 'http://localhost:5173', credentials: true });
    await api.register(rawBody, { field: 'rawBody', global: false, encoding: false, runFirst: true });
    api.addHook('onRoute', options => { if (options.url.includes('/webhooks/')) options.config = { ...options.config, rawBody: true }; });
    await registerAuth(api, db); await registerComponentReview(api, db); await registerBanking(api, db); await registerFx(api, db); await registerInventory(api, db); await registerProduction(api, db); await registerProcurementRoutes(api, db); await registerIntegrations(api, db); await registerMatching(api, db); await registerInvoices(api, db); await registerMailbox(api, db);
    api.get('/audit', async () => db.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 1000 }));
    api.get('/reports',async()=>costReports(db));
  }, { prefix: '/api' });
  return app;
}
