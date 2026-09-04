import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { ensure, mutate } from './core.js';

export function hashPassword(password: string) { const salt = randomBytes(16).toString('hex'); return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`; }
function checkPassword(password: string, hash: string) { const [salt, value] = hash.split(':'); const actual = scryptSync(password, salt, 64); const expected = Buffer.from(value, 'hex'); return actual.length === expected.length && timingSafeEqual(actual, expected); }
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const publicUser = (u: any) => ({ id: u.id, email: u.email, name: u.name, role: u.role });
export async function bootstrapAdmin(db: PrismaClient) {
  const email = process.env.ADMIN_EMAIL?.toLowerCase(), password = process.env.ADMIN_PASSWORD;
  if (await db.user.count()) return;
  ensure(email && password && password.length >= 12 && !password.startsWith('CHANGE_ME'), 'Set ADMIN_EMAIL and ADMIN_PASSWORD (at least 12 characters) to create the first administrator', 503);
  await db.user.create({ data: { email, name: 'Administrator', passwordHash: hashPassword(password), role: 'ADMIN' } });
}
export async function registerAuth(app: FastifyInstance, db: PrismaClient) {
  const secure = process.env.COOKIE_SECURE !== 'false' && process.env.NODE_ENV === 'production';
  const cookie = (token: string, age: number) => `godmode_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${secure ? '; Secure' : ''}`;
  const failures = new Map<string, { count: number; until: number }>();
  app.addHook('onRequest', async (q, r) => {
    const path = q.url.split('?')[0].replace(/^\/api(?=\/|$)/, '');
    if (path === '/health' || path === '/auth/login' || path.startsWith('/integrations/shopify/webhooks/')) return;
    if (path.startsWith('/factory/') && process.env.FACTORY_API_TOKEN) {
      const token = q.headers.authorization?.replace(/^Bearer /, '') ?? '';
      if (token && timingSafeEqual(Buffer.from(digest(token)), Buffer.from(digest(process.env.FACTORY_API_TOKEN)))) { (q as any).user = { email: 'controller', role: 'OPERATOR' }; return; }
    }
    const token = q.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith('godmode_session='))?.slice(16);
    const session = token ? await db.session.findUnique({ where: { tokenHash: digest(token) }, include: { user: true } }) : null;
    if (!session || session.expiresAt < new Date() || !session.user.active) return r.code(401).send({ error: 'Sign in to Godmode Ops' });
    (q as any).user = publicUser(session.user);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(q.method)) {
      ensure(q.headers.origin === process.env.WEB_ORIGIN || (!q.headers.origin && process.env.NODE_ENV !== 'production'), 'Request origin is not allowed', 403);
      ensure(q.headers['content-type']?.startsWith('application/json'), 'Use application/json', 415);
      ensure(session.user.role !== 'VIEWER' || path === '/auth/logout', 'Your account has read-only access', 403);
      if (/^\/(users|shopify\/mappings|integrations\/shopify\/sync|integrations\/events)/.test(path)) ensure(session.user.role === 'ADMIN', 'Administrator access required', 403);
    }
  });
  app.post('/auth/login', async (q, r) => {
    ensure(!q.headers.origin || q.headers.origin === process.env.WEB_ORIGIN, 'Request origin is not allowed', 403);
    const b = z.object({ email: z.string().email(), password: z.string().max(512) }).parse(q.body);
    const key = q.ip, now = Date.now(), fail = failures.get(key);
    ensure(!fail || fail.until < now || fail.count < 8, 'Too many sign-in attempts. Try again in 15 minutes.', 429);
    const user = await db.user.findUnique({ where: { email: b.email.toLowerCase() } });
    if (!user?.active || !checkPassword(b.password, user.passwordHash)) {
      if (failures.size > 10000) for (const [k, v] of failures) if (v.until < now) failures.delete(k);
      failures.set(key, { count: fail && fail.until > now ? fail.count + 1 : 1, until: now + 900000 });
      return r.code(401).send({ error: 'Email or password is incorrect' });
    }
    failures.delete(key);
    const token = randomBytes(32).toString('hex');
    await db.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    await db.session.create({ data: { tokenHash: digest(token), userId: user.id, expiresAt: new Date(now + 43200000) } });
    return r.header('set-cookie', cookie(token, 43200)).send(publicUser(user));
  });
  app.get('/auth/me', async q => (q as any).user);
  app.post('/auth/logout', async (q, r) => {
    const token = q.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith('godmode_session='))?.slice(16);
    if (token) await db.session.deleteMany({ where: { tokenHash: digest(token) } });
    return r.header('set-cookie', cookie('', 0)).send({ ok: true });
  });
  app.get('/users', async q => { ensure((q as any).user.role === 'ADMIN', 'Administrator access required', 403); return db.user.findMany({ select: { id: true, email: true, name: true, role: true, active: true } }); });
  app.post('/users', async q => {
    const b = z.object({ email: z.string().email(), name: z.string().trim().min(1), password: z.string().min(12), role: z.enum(['ADMIN', 'OPERATOR', 'VIEWER']) }).parse(q.body);
    return mutate(db, q, 'Create user', async tx => publicUser(await tx.user.create({ data: { email: b.email.toLowerCase(), name: b.name, role: b.role, passwordHash: hashPassword(b.password) } })));
  });
  app.patch('/users/:id', async q => {
    const { id } = q.params as { id: string };
    const b = z.object({ active: z.boolean().optional(), password: z.string().min(12).optional() }).parse(q.body);
    ensure(id !== (q as any).user.id || b.active !== false, 'You cannot disable your own account');
    return mutate(db, q, 'Update user', async tx => { const u = await tx.user.update({ where: { id }, data: { active: b.active, passwordHash: b.password ? hashPassword(b.password) : undefined } }); await tx.session.deleteMany({ where: { userId: id } }); return publicUser(u); });
  });
}
