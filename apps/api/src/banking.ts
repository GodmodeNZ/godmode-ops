import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { actor, ensure, mutate, transaction } from './core.js';
import { readConnection, saveConnection } from './connections.js';
import { AKAHU_SCOPES, AkahuError, akahuRequest, bankingCallback, bankingGate, personalTestGate, personalTestWindow, internalUseGate, internalAccountAllowed, bankSyncInterval } from './akahu-client.js';
import { bankFeed, bankIdle, loadBankAccounts, requestBankRefresh, runBankSync, startBankSync } from './banking-sync.js';
import { registerReconciliation } from './bank-reconciliation.js';
import { D } from './fx.js';
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const cookie = (s: string, uri: string, age = 600) => `erp_bank_oauth=${s}; HttpOnly; SameSite=Lax; Path=/api/banking/callback; Max-Age=${age}${uri.startsWith('https:') ? '; Secure' : ''}`;

export async function registerBanking(app: FastifyInstance, db: PrismaClient) {
  if (process.env.AKAHU_PERSONAL_TEST === 'true') personalTestGate();
  app.addHook('onRequest',async q=>{
    if(q.url.startsWith('/api/banking') && process.env.AKAHU_INTERNAL_APPROVED==='true' && !process.env.WEB_ORIGIN?.startsWith('https:'))
      ensure(['127.0.0.1','::1','::ffff:127.0.0.1'].includes(q.ip),'Local internal banking is accessible only on this computer. Use HTTPS for remote banking access.',403);
  });
  app.post('/banking/personal-test', { logLevel: 'silent' }, async q => {
    personalTestGate();
    const b = z.object({ appId: z.string().regex(/^app_token_[\w-]+$/).max(1000), userToken: z.string().regex(/^user_token_[\w-]+$/).max(1000), since: z.string().datetime(), until: z.string().datetime() }).strict().parse(q.body);
    const window = personalTestWindow(b.since, b.until);
    return mutate(db, q, 'Configure isolated personal-app cached-read test', async tx => {
      const f = await bankFeed(tx); bankIdle(f);
      ensure(!(await tx.bankSync.count({ where: { status: { in: ['RUNNING', 'FAILED'] } } })), 'Finish or cancel the previous import first.', 409);
      ensure(f.status !== 'CONNECTED', 'Disconnect locally before replacing personal-test credentials.', 409);
      await saveConnection(tx, 'AKAHU', { kind: 'PERSONAL_TEST', appId: b.appId, accessToken: b.userToken, since: b.since, until: b.until }, { configured: true });
      await tx.bankFeed.update({ where: { id: f.id }, data: { mode: 'PERSONAL_TEST', status: 'CONNECTED', since: window.start, autoSync: false, error: null, nextRequestAt: null, version: { increment: 1 } } });
      return { configured: true, message: 'Tokens encrypted locally. Load accounts to verify access, then select one BNZ account.' };
    });
  });
  app.post('/banking/internal-personal', { logLevel: 'silent' }, async q => {
    internalUseGate();
    const b = z.object({appId:z.string().regex(/^app_token_[\w-]+$/).max(1000),userToken:z.string().regex(/^user_token_[\w-]+$/).max(1000),since:z.string().date()}).strict().parse(q.body);
    internalUseGate(b.appId);
    ensure(new Date(b.since) <= new Date(), 'Import start date cannot be in the future.', 400);
    return mutate(db,q,'Configure approved internal personal-app read access',async tx=>{
      const f=await bankFeed(tx); bankIdle(f);
      ensure(!['CONNECTED','DISCONNECT_FAILED'].includes(f.status), 'Disconnect locally before replacing credentials.',409);
      ensure(!(await tx.bankSync.count({where:{status:{in:['RUNNING','FAILED']}}})), 'Finish or cancel the previous import first.',409);
      await saveConnection(tx,'AKAHU',{kind:'INTERNAL_PERSONAL',appId:b.appId,accessToken:b.userToken,configuredAt:new Date().toISOString()},{configured:true});
      await tx.bankAccount.updateMany({data:{selected:false}});
      await tx.bankFeed.update({where:{id:f.id},data:{mode:'INTERNAL_PERSONAL',status:'CONNECTED',since:new Date(b.since),autoSync:false,lastSyncAt:null,error:null,nextRequestAt:null,version:{increment:1}}});
      return {configured:true,message:'Internal read access saved securely. Load and select the approved account; verify two imports before scheduling.'};
    });
  });
  app.get('/banking/status', async () => {
    const feed = await bankFeed(db), connection = await db.integrationConnection.findUnique({ where: { provider: 'AKAHU' }, select: { metadata: true } });
    const { leaseOwner, ...safeFeed } = feed;
    return { ...safeFeed, internalUseEnabled: process.env.AKAHU_INTERNAL_APPROVED === 'true', syncIntervalHours: bankSyncInterval(feed.mode)/3600000, personalTestEnabled: process.env.AKAHU_PERSONAL_TEST === 'true', configured: Boolean(connection), callbackUrl: bankingCallback(), commercialApproved: process.env.AKAHU_COMMERCIAL_APPROVED === 'true',
      accounts: await db.bankAccount.findMany({ orderBy: { name: 'asc' } }),
      sync: await db.bankSync.findFirst({ orderBy: { startedAt: 'desc' }, select: { id: true, status: true, pages: true, imported: true, accountIndex: true, start: true, end: true, error: true, completedAt: true } }) };
  });
  app.post('/banking/configure', async q => {
    ensure(process.env.AKAHU_PERSONAL_TEST !== 'true', 'Full-app configuration is disabled on the personal test instance.', 409);
    const b = z.object({ appId: z.string().regex(/^app_token_[\w-]+$/).optional(), appSecret: z.string().min(8).max(1000).optional(), mode: z.enum(['SANDBOX', 'PRODUCTION']), since: z.string().date() }).strict().parse(q.body);
    return mutate(db, q, 'Configure Akahu full-app banking (credentials encrypted)', async tx => {
      const f = await bankFeed(tx); bankIdle(f);
      ensure(!['CONNECTED', 'DISCONNECT_FAILED'].includes(f.status), 'Disconnect and revoke the existing bank connection before replacing credentials.', 409);
      ensure(!(await tx.bankOAuthState.count({ where: { expiresAt: { gt: new Date() } } })), 'Finish the pending connection or wait ten minutes before changing settings.', 409);
      if (b.mode === 'PRODUCTION') bankingGate(b.mode);
      ensure(new Date(b.since) <= new Date(), 'Import start date cannot be in the future.', 400);
      const old = await readConnection(tx, 'AKAHU'); const c = { appId: b.appId || old?.appId, appSecret: b.appSecret || old?.appSecret };
      ensure(c.appId && c.appSecret, 'Enter the full-app App ID Token and App Secret. Personal-app user tokens are not accepted.', 400);
      await saveConnection(tx, 'AKAHU', c, { configured: true });
      await tx.bankFeed.update({ where: { id: f.id }, data: { mode: b.mode, since: new Date(b.since), status: 'CONFIGURED', version: { increment: 1 }, autoSync: false, error: null } }); return { configured: true };
    });
  });
  app.post('/banking/authorize', { logLevel: 'silent' }, async (q, r) => {
    const state = randomBytes(32).toString('hex'), uri = bankingCallback();
    const config = await transaction(db, async tx => {
      const f = await bankFeed(tx); bankingGate(f.mode); bankIdle(f);
      ensure(f.status !== 'CONNECTED' && f.status !== 'DISCONNECT_FAILED', 'Revoke the existing connection before reconnecting.', 409);
      const c = await readConnection(tx, 'AKAHU'); ensure(c?.appId && c?.appSecret, 'Configure full-app credentials first.', 400);
      await tx.bankOAuthState.deleteMany({ where: { OR: [{ expiresAt: { lt: new Date() } }, { userId: (q as any).user.id }] } });
      await tx.bankOAuthState.create({ data: { hash: digest(state), userId: (q as any).user.id, configVersion: f.version, redirectUri: uri, expiresAt: new Date(Date.now() + 600000) } }); return c;
    });
    const url = new URL('https://oauth.akahu.nz');
    for (const [k, v] of Object.entries({ client_id: config.appId, redirect_uri: uri, response_type: 'code', scope: AKAHU_SCOPES, state })) url.searchParams.set(k, String(v));
    return r.header('set-cookie', cookie(state, uri)).header('cache-control', 'no-store').send({ url: url.toString() });
  });
  app.get('/banking/callback', { logLevel: 'silent' }, async (q, r) => {
    r.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
    const b = z.object({ state: z.string().regex(/^[a-f0-9]{64}$/), code: z.string().max(2000).optional(), event: z.enum(['ACCEPT', 'UPDATE', 'REVOKE']).optional(), error: z.string().optional() }).parse(q.query);
    const browserState = q.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith('erp_bank_oauth='))?.slice('erp_bank_oauth='.length);
    ensure(browserState === b.state, 'Bank connection state does not match this browser. Start Connect again.', 400);
    const pending = await transaction(db, async tx => {
      const s = await tx.bankOAuthState.findUnique({ where: { hash: digest(b.state) } }); ensure(s && s.expiresAt > new Date(), 'Bank connection expired or already used. Start Connect again.', 400);
      await tx.bankOAuthState.delete({ where: { hash: s.hash } });
      const user = await tx.user.findUnique({ where: { id: s.userId } }); ensure(user?.active && user.role === 'ADMIN', 'Bank administrator access was revoked.', 403);
      const f = await bankFeed(tx); ensure(f.version === s.configVersion, 'Bank settings changed. Start Connect again.', 409); bankingGate(f.mode); bankIdle(f); await tx.bankFeed.update({where:{id:f.id},data:{leaseOwner:s.hash,leaseUntil:new Date(Date.now()+45000)}}); return s;
    });
    try {
    r.header('set-cookie', cookie('', pending.redirectUri, 0));
    if (b.error || b.event === 'REVOKE' || !b.code) {
      await db.bankFeed.update({ where: { id: 'akahu' }, data: { error: 'Bank access was not granted. Start Connect again when ready.' } });
      return r.redirect('/?section=Banking');
    }
    const c = await readConnection(db, 'AKAHU');
    const tokens = await akahuRequest(c, '/token', 'POST', { grant_type: 'authorization_code', code: b.code, redirect_uri: pending.redirectUri, client_id: c.appId, client_secret: c.appSecret });
    ensure(typeof tokens.access_token === 'string' && tokens.token_type?.toLowerCase() === 'bearer', 'Akahu did not return a usable token. Reconnect.', 502);
    const scopes = String(tokens.scope ?? '').split(/\s+/);
    if (!['ACCOUNTS', 'TRANSACTIONS'].every(s => scopes.includes(s)) || scopes.some(s => !AKAHU_SCOPES.split(' ').includes(s))) {
      try { await akahuRequest({ ...c, accessToken: tokens.access_token }, '/token', 'DELETE'); } catch {
        await transaction(db, async tx => { await saveConnection(tx, 'AKAHU', { ...c, accessToken: tokens.access_token }, { configured: true }); await tx.bankFeed.update({ where: { id: 'akahu' }, data: { status: 'DISCONNECT_FAILED', autoSync: false, error: 'Unexpected scopes. Revocation failed; retry Disconnect or revoke in my.akahu.nz.' } }); });
      }
      ensure(false, 'Akahu granted unexpected permissions. Only account and transaction read scopes are permitted. Access was not enabled; check connection status for revocation.', 502);
    }
    await transaction(db, async tx => {
      const f = await bankFeed(tx); ensure(f.version === pending.configVersion, 'Bank settings changed. Reconnect.', 409);
      await saveConnection(tx, 'AKAHU', { ...c, accessToken: tokens.access_token }, { configured: true });
      await tx.bankFeed.update({ where: { id: f.id }, data: { status: 'CONNECTED', version: { increment: 1 }, nextRequestAt: null, error: null } });
      await tx.auditLog.create({ data: { actor: pending.userId, action: 'Connect Akahu account and transaction read access' } });
    });
    return r.redirect('/?section=Banking');
    } catch (e) { await db.bankFeed.updateMany({where:{id:'akahu',leaseOwner:pending.hash,status:{not:'DISCONNECT_FAILED'}},data:{error:e instanceof AkahuError?e.message:'Bank connection was not completed. Check full-app scopes and reconnect.'}}); throw e;
    } finally { await db.bankFeed.updateMany({where:{id:'akahu',leaseOwner:pending.hash},data:{leaseOwner:null,leaseUntil:null}}); }
  });
  app.post('/banking/accounts/discover', async () => loadBankAccounts(db));
  app.post('/banking/accounts/select', async q => {
    const b = z.object({ ids: z.array(z.string()).max(100), autoSync: z.boolean().default(false) }).parse(q.body);
    return mutate(db, q, 'Select BNZ accounts for cached bank imports', async tx => {
      const f = await bankFeed(tx); bankingGate(f.mode); bankIdle(f); ensure(f.status === 'CONNECTED', 'Connect Akahu first', 409);
      ensure(!(await tx.bankSync.count({ where: { status: { in: ['RUNNING', 'FAILED'] } } })), 'Finish or cancel the pending import first.', 409);
      const ids = [...new Set(b.ids)];
      if (f.mode === 'INTERNAL_PERSONAL') {
        ensure(ids.length === 1 && internalAccountAllowed(ids[0]), 'Select only the approved internal BNZ account.', 400);
        const c=await readConnection(tx,'AKAHU');
        if (b.autoSync) ensure(await tx.bankSync.count({where:{status:'COMPLETE',startedAt:{gte:new Date(c.configuredAt)},start:{gte:new Date(f.since.getTime()-1)}}}) >= 2, 'Complete the initial import and repeat-import verification before scheduling.',409);
      }
      if (f.mode === 'PERSONAL_TEST') ensure(ids.length === 1 && !b.autoSync, 'Select exactly one BNZ account; scheduled syncing is disabled for personal tests.', 400);
      ensure((await tx.bankAccount.count({ where: { id: { in: ids }, eligible: true } })) === ids.length, 'Only eligible connected BNZ accounts can be selected.', 400);
      await tx.bankAccount.updateMany({ data: { selected: false } }); await tx.bankAccount.updateMany({ where: { id: { in: ids } }, data: { selected: true } });
      await tx.bankFeed.update({ where: { id: f.id }, data: { autoSync: b.autoSync && ids.length > 0 } }); return { selected: ids.length };
    });
  });
  app.post('/banking/sync', async () => { await startBankSync(db); return runBankSync(db); });
  app.post('/banking/sync/cancel', async q => mutate(db, q, 'Cancel bank import without recording payments', async tx => {
    bankIdle(await bankFeed(tx)); await tx.bankSync.updateMany({ where: { status: { in: ['RUNNING', 'FAILED'] } }, data: { status: 'CANCELLED', completedAt: new Date() } });
    await tx.bankFeed.update({ where: { id: 'akahu' }, data: { autoSync: false } }); return { cancelled: true };
  }));
  app.post('/banking/refresh-bank', async () => requestBankRefresh(db));
  app.post('/banking/disconnect', async q => {
    const { purgeUnallocated } = z.object({ purgeUnallocated: z.boolean().default(false) }).parse(q.body);
    const owner = randomBytes(20).toString('hex');
    const c = await transaction(db, async tx => {
      const f = await bankFeed(tx); bankIdle(f); await tx.bankFeed.update({ where: { id: f.id }, data: { leaseOwner: owner, leaseUntil: new Date(Date.now() + 45000), autoSync: false } }); return readConnection(tx, 'AKAHU');
    });
    try {
      if (c?.kind === 'INTERNAL_PERSONAL') { /* Local deletion remains possible if approval is withdrawn. */ }
      else if (c?.kind === 'PERSONAL_TEST') personalTestGate();
      else if (c?.accessToken) { try { await akahuRequest(c, '/token', 'DELETE'); } catch (e) { if (!(e instanceof AkahuError && e.providerStatus === 401)) throw e; } }
      await transaction(db, async tx => {
        await tx.bankOAuthState.deleteMany(); await tx.bankSync.updateMany({ where: { status: { in: ['RUNNING', 'FAILED'] } }, data: { status: 'CANCELLED' } });
        if (['PERSONAL_TEST','INTERNAL_PERSONAL'].includes(c?.kind)) await tx.integrationConnection.deleteMany({ where: { provider: 'AKAHU' } });
        else if (c) await saveConnection(tx, 'AKAHU', { appId: c.appId, appSecret: c.appSecret }, { configured: true });
        if (purgeUnallocated) await tx.bankTransaction.deleteMany({ where: { allocations: { none: {} } } });
        await tx.bankAccount.updateMany({ data: { selected: false, eligible: false, status: 'DISCONNECTED', pending: [] } });
        await tx.bankFeed.update({ where: { id: 'akahu' }, data: { status: 'DISCONNECTED', error: null, version: { increment: 1 }, leaseOwner: null, leaseUntil: null } });
        await tx.auditLog.create({ data: { actor: actor(q), action: ['PERSONAL_TEST','INTERNAL_PERSONAL'].includes(c?.kind) ? 'Disconnect personal test locally and delete saved tokens' : 'Revoke Akahu access and disconnect bank feeds', reference: purgeUnallocated ? 'Unallocated transactions removed; reconciliation evidence retained' : 'Reconciliation history retained' } });
      }); return { disconnected: true };
    } catch {
      await db.bankFeed.update({ where: { id: 'akahu' }, data: { status: 'DISCONNECT_FAILED', error: 'Revocation could not be confirmed. Imports are stopped. Retry Disconnect, or revoke access at my.akahu.nz and retry.', leaseOwner: null, leaseUntil: null } });
      ensure(false, 'Revocation could not be confirmed. Token retained encrypted for a safe retry; bank imports stopped.', 502);
    }
  });
  app.get('/banking/transactions', async q => {
    const b = z.object({ offset: z.coerce.number().int().min(0).default(0), accountId: z.string().optional(), search: z.string().max(200).optional() }).parse(q.query);
    const where = { ...(b.accountId ? { accountId: b.accountId } : {}), ...(b.search ? { description: { contains: b.search, mode: 'insensitive' as const } } : {}) };
    const rows = await db.bankTransaction.findMany({ where, orderBy: [{ date: 'desc' }, { id: 'asc' }], take: 50, skip: b.offset, include: { account: true, allocations: { include: { invoice: { select: { invoiceNumber: true } } } } } });
    return { total: await db.bankTransaction.count({ where }), offset: b.offset, rows: rows.map(t => ({ ...t, unallocatedNzd: t.currency === 'NZD' && t.amount.lt(0) ? t.allocations.filter(a => !a.reversedAt).reduce((n, a) => n.sub(a.amountNzd).sub(a.feeNzd), t.amount.abs()).toFixed(2) : null })) };
  });
  app.get('/banking/invoices', async () => db.supplierInvoice.findMany({ where: { status: { in: ['REVIEW', 'APPROVED'] } }, select: { id: true, version: true, invoiceNumber: true, currency: true, total: true, supplier: { select: { name: true } }, payments: true, bankAllocations: { where: { reversedAt: null } } } }));
  await registerReconciliation(app, db);
  let polling: Promise<void> | undefined;
  const poll = async () => {
    const f = await db.bankFeed.findUnique({ where: { id: 'akahu' } }); if (!f || f.status !== 'CONNECTED' || (f.leaseUntil && f.leaseUntil > new Date()) || (f.nextRequestAt && f.nextRequestAt > new Date())) return;
    if (!(await db.bankSync.count({ where: { status: { in: ['RUNNING', 'FAILED'] } } }))) {
      if (!f.autoSync || (f.lastSyncAt && Date.now() - f.lastSyncAt.getTime() < bankSyncInterval(f.mode))) return;
      await startBankSync(db);
    }
    await runBankSync(db);
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  if (process.env.NODE_ENV !== 'test' && process.env.AKAHU_PERSONAL_TEST !== 'true') {
    timer = setInterval(() => { if (!polling) polling = poll().catch(() => {}).finally(() => { polling = undefined; }); }, 10000); timer.unref();
  }
  app.addHook('onClose', async () => { if (timer) clearInterval(timer); await polling; });
}
