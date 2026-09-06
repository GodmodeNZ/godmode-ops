import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerAuth, hashPassword } from '../apps/api/src/auth.js';

// Exercise HTTP cookies and server expiry together without an external database.
test('remembered sessions survive a server restart and still expire or revoke', async () => {
  const user = { id: 'test-user', email: 'session@example.test', name: 'Session test', role: 'ADMIN', active: true, passwordHash: hashPassword('session-test-password') };
  const sessions = new Map<string, any>();
  const db: any = {
    user: { findUnique: async () => user },
    session: {
      create: async ({ data }: any) => { sessions.set(data.tokenHash, { ...data, user }); return data; },
      findUnique: async ({ where }: any) => sessions.get(where.tokenHash),
      deleteMany: async ({ where }: any) => { for (const [key, s] of sessions) if (where.tokenHash === key || (where.expiresAt && s.expiresAt < where.expiresAt.lt)) sessions.delete(key); }
    }
  };
  const makeApp = async () => { const app = Fastify(); await registerAuth(app, db); return app; };
  let app = await makeApp();
  const login = (rememberMe?: boolean) => app.inject({ method: 'POST', url: '/auth/login', payload: { email: user.email, password: 'session-test-password', ...(rememberMe === undefined ? {} : { rememberMe }) } });
  try {
    for (const remember of [undefined, false, true]) {
      const start = Date.now();
      const res = await login(remember);
      assert.equal(res.statusCode, 200);
      const cookie = String(res.headers['set-cookie']);
      const seconds = remember ? 2592000 : 43200;
      assert.ok(cookie.includes(`Max-Age=${seconds}`));
      assert.ok(cookie.includes('HttpOnly; SameSite=Strict; Path=/'));
      const session = [...sessions.values()].at(-1);
      assert.ok(session.expiresAt.getTime() >= start + seconds * 1000);
      assert.ok(session.expiresAt.getTime() <= Date.now() + seconds * 1000);
      assert.ok(!cookie.includes(session.tokenHash));
    }
    const res = await login(true);
    const cookie = String(res.headers['set-cookie']).split(';')[0];
    await app.close(); app = await makeApp();
    assert.equal((await app.inject({ url: '/auth/me', headers: { cookie } })).statusCode, 200);
    user.active = false;
    assert.equal((await app.inject({ url: '/auth/me', headers: { cookie } })).statusCode, 401);
    user.active = true;
    const logout = await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie, ...(process.env.WEB_ORIGIN ? { origin: process.env.WEB_ORIGIN } : {}) }, payload: {} });
    assert.equal(logout.statusCode, 200);
    assert.ok(String(logout.headers['set-cookie']).includes('Max-Age=0'));
    assert.equal((await app.inject({ url: '/auth/me', headers: { cookie } })).statusCode, 401);
    const expired = await login(true);
    for (const s of sessions.values()) s.expiresAt = new Date(Date.now() - 1000);
    assert.equal((await app.inject({ url: '/auth/me', headers: { cookie: String(expired.headers['set-cookie']).split(';')[0] } })).statusCode, 401);
  } finally { await app.close(); }
});
