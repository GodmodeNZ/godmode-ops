import { config } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import staticFiles from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { buildApp } from './app.js';
import { bootstrapAdmin } from './auth.js';
config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });
const db = new PrismaClient();
await bootstrapAdmin(db);
const app = await buildApp(db);
const webRoot = fileURLToPath(new URL('../../web/dist/', import.meta.url));
if (existsSync(webRoot)) {
  await app.register(staticFiles, { root: webRoot });
  app.setNotFoundHandler((q, r) => q.url.startsWith('/api/') ? r.code(404).send({ error: 'Endpoint not found' }) : r.sendFile('index.html'));
}
await app.listen({ port: Number(process.env.API_PORT ?? 4000), host: '0.0.0.0' });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, async () => { await app.close(); await db.$disconnect(); process.exit(0); });
