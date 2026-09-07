import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { buildApp } from '../apps/api/src/app.js';
import { hashPassword } from '../apps/api/src/auth.js';
import { AKAHU_SCOPES, bankingGate, akahuRequest, bankSyncInterval } from '../apps/api/src/akahu-client.js';
import { readConnection } from '../apps/api/src/connections.js';
import { runBankSync, loadBankAccounts, requestBankRefresh, startBankSync } from '../apps/api/src/banking-sync.js';
import { matchEvidence } from '../apps/api/src/bank-reconciliation.js';

assert.match(new URL(process.env.DATABASE_URL!).pathname, /^\/(godmode_fx_isolated_test_\d+|godmode_ops_ci_test)$/);
process.env.NODE_ENV = 'test'; process.env.WEB_ORIGIN = 'http://localhost:4000'; process.env.INTEGRATION_ENCRYPTION_KEY = 'b2'.repeat(32); delete process.env.AKAHU_COMMERCIAL_APPROVED;
const db = new PrismaClient(); let app = await buildApp(db, false), cookie = ''; const prefix = 'bank-' + Date.now();
const appId = 'app_token_synthetic_test', secret = 'synthetic-full-app-secret-not-real', token = 'user_token_synthetic_only';
let statusCode = 200, failSecond = false, replacement = false, pendingItems: any[] = [], refreshes = 0, calls: string[] = [];
const account = { _id: 'acc_synthetic_bnz', _authorisation: 'auth_synthetic', name: 'Synthetic BNZ', connection: { name: 'BNZ' }, status: 'ACTIVE', attributes: ['TRANSACTIONS'], balance: { currency: 'NZD' }, formatted_account: '00-0000-0000000-00' };
const txn = (id: string, amount: number, description = 'SYNTHETIC supplier invoice TEST100') => ({ _id: id, _account: account._id, date: '2026-03-09T20:00:00.000Z', amount, description, updated_at: '2026-03-11T00:00:00.000Z', meta: { reference: 'TEST100', particulars: 'SYNTHETIC', conversion: { amount: 100, currency: 'USD' } } });
let posted = [txn('trans_synthetic_1', -165), txn('trans_synthetic_2', -150)];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input: any, options: any = {}) => {
  const url = new URL(String(input)); assert.equal(url.origin, 'https://api.akahu.io'); assert.equal(options.headers['X-Akahu-Id'], appId); calls.push((options.method ?? 'GET') + ' ' + url.pathname);
  const ok = (body: any) => new Response(JSON.stringify({ success: true, ...body }));
  if (statusCode !== 200) return new Response('{}', { status: statusCode, headers: { 'retry-after': '120' } });
  if (url.pathname === '/v1/token' && options.method === 'POST') {
    const b = JSON.parse(options.body); assert.equal(b.client_secret, secret); assert.equal(b.redirect_uri, 'http://localhost:4000/api/banking/callback');
    return ok({ access_token: token, token_type: 'bearer', scope: AKAHU_SCOPES });
  }
  assert.equal(options.headers.authorization, 'Bearer ' + token);
  if (url.pathname === '/v1/token' && options.method === 'DELETE') return ok({});
  if (url.pathname === '/v1/accounts') return ok({ items: [account, { ...account, _id: 'acc_not_bnz', connection: { name: 'Other bank' } }, { ...account, _id: 'acc_inactive', status: 'INACTIVE' }], cursor: { next: null } });
  if (url.pathname.startsWith('/v1/refresh/')) { refreshes++; return ok({}); }
  if (url.pathname.endsWith('/pending')) return ok({ items: pendingItems });
  assert.equal(url.pathname, '/v1/accounts/' + account._id + '/transactions'); assert.ok(url.searchParams.has('start')); assert.ok(url.searchParams.has('end'));
  if (url.searchParams.get('cursor') === 'synthetic-next') { if (failSecond) return new Response('{}', { status: 503 }); return ok({ items: posted.slice(1), cursor: { next: null } }); }
  return ok({ items: posted.slice(0, 1), cursor: { next: posted.length > 1 ? 'synthetic-next' : null } });
};
async function request(path: string, body?: any, expected = 200, method = 'POST', key = randomUUID()) {
  const r = await app.inject({ method: body === undefined ? 'GET' : method as any, url: '/api' + path, headers: { cookie, origin: process.env.WEB_ORIGIN!, 'content-type': 'application/json', 'idempotency-key': key }, payload: body });
  assert.equal(r.statusCode, expected, path + ': ' + r.body); return r;
}
async function invoice(number: string, currency: string, total: number, approved = false) {
  return db.supplierInvoice.create({ data: { fingerprint: randomUUID(), source: 'SYNTHETIC_TEST', invoiceNumber: number, invoiceDate: new Date('2026-03-08'), currency, total, extractedText: 'SYNTHETIC FIXTURE', extractionWarnings: [], supplier: { create: { code: randomUUID(), name: 'SYNTHETIC Supplier' } }, ...(approved ? { status: 'APPROVED', fxRate: 1.6, fxLockedAt: new Date(), fxConfirmed: true, nzdSnapshot: { totalNzd: '160.00', immutable: 'synthetic' } } : {}) } });
}
await test('Akahu read-only OAuth, durable import and reconciliation', async t => {
  try {
    const admin = await db.user.create({ data: { email: prefix + '@test.invalid', name: 'Synthetic bank admin', passwordHash: hashPassword('synthetic-password-123'), role: 'ADMIN' } });
    cookie = String((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: admin.email, password: 'synthetic-password-123' } })).headers['set-cookie']).split(';')[0];
    await t.test('commercial and personal-token gates protect the live installation', async () => {
      await request('/banking/configure', { appId, appSecret: secret, mode: 'PRODUCTION', since: '2026-03-01' }, 409);
      await request('/banking/configure', { appId, appSecret: secret, accessToken: token, mode: 'SANDBOX', since: '2026-03-01' }, 400);
      const saved = process.env.DATABASE_URL; process.env.DATABASE_URL = 'postgresql://test:fake@localhost/godmode_ops_test';
      assert.throws(() => bankingGate('SANDBOX'), /isolated/); process.env.DATABASE_URL = saved;
      await assert.rejects(akahuRequest({ appId }, '/payments', 'POST', {}), /Unsupported/);
      await request('/banking/configure', { appId, appSecret: secret, mode: 'SANDBOX', since: '2026-03-01' });
      const stored = await db.integrationConnection.findUniqueOrThrow({ where: { provider: 'AKAHU' } }); assert.ok(!stored.encrypted.includes(secret));
      const publicState = (await request('/banking/status')).body; assert.ok(!publicState.includes(secret) && !publicState.includes(token) && !publicState.includes(appId));
    });
    await t.test('OAuth state survives restart, is browser-bound, expiring and single use', async () => {
      const expired = await request('/banking/authorize', {}); const oldState = new URL(expired.json().url).searchParams.get('state')!;
      await db.bankOAuthState.updateMany({data:{expiresAt:new Date(0)}});
      assert.equal((await app.inject({method:'GET',url:'/api/banking/callback?state='+oldState+'&code=synthetic',headers:{cookie:'erp_bank_oauth='+oldState}})).statusCode,400);
      const auth = await request('/banking/authorize', {}); const url = new URL(auth.json().url), state = url.searchParams.get('state')!;
      assert.equal(url.searchParams.get('scope'), AKAHU_SCOPES); assert.ok(!url.toString().includes(secret)); assert.ok(!AKAHU_SCOPES.includes('PAYMENTS'));
      await app.close(); app = await buildApp(db, false);
      await app.inject({ method: 'GET', url: '/api/banking/callback?state=' + state + '&code=fake&event=ACCEPT' }).then(r => assert.equal(r.statusCode, 400));
      const r = await app.inject({ method: 'GET', url: '/api/banking/callback?state=' + state + '&code=synthetic&event=ACCEPT', headers: { cookie: 'erp_bank_oauth=' + state } });
      assert.equal(r.statusCode, 302); assert.ok(!r.body.includes(token)); assert.equal(r.headers['referrer-policy'], 'no-referrer');
      const replay = await app.inject({ method: 'GET', url: '/api/banking/callback?state=' + state + '&code=synthetic', headers: { cookie: 'erp_bank_oauth=' + state } }); assert.equal(replay.statusCode, 400);
      assert.equal((await readConnection(db, 'AKAHU')).accessToken, token);
    });
    await t.test('eligible BNZ selection excludes other banks and inactive accounts', async () => {
      await loadBankAccounts(db); const s = (await request('/banking/status')).json(); assert.equal(s.accounts.length, 2);
      await request('/banking/accounts/select', { ids: ['acc_not_bnz'], autoSync: false }, 400);
      await request('/banking/accounts/select', { ids: ['acc_inactive'], autoSync: false }, 400);
      await request('/banking/accounts/select', { ids: [account._id], autoSync: false });
    });
    await t.test('failed pagination saves cursor; stale lease and server restart resume safely', async () => {
      failSecond = true; await request('/banking/sync', {}, 502);
      const job = await db.bankSync.findFirstOrThrow({ orderBy: { startedAt: 'desc' } }); assert.equal(job.cursor, 'synthetic-next'); assert.equal(job.pages, 1); assert.equal(await db.bankTransaction.count(), 1);
      await db.bankFeed.update({ where: { id: 'akahu' }, data: { nextRequestAt: null, leaseOwner: 'crashed-worker', leaseUntil: new Date(0) } });
      await app.close(); app = await buildApp(db, false); failSecond = false; await runBankSync(db);
      assert.equal(await db.bankTransaction.count(), 2); assert.equal((await db.bankSync.findUniqueOrThrow({ where: { id: job.id } })).status, 'COMPLETE');
      await request('/banking/sync', {}); assert.equal(await db.bankTransaction.count(), 2); assert.equal(refreshes, 0);
    });
    await t.test('pending preview is replaced; only stable posted IDs can reconcile', async () => {
      pendingItems = [{ _account: account._id, date: '2026-03-10', amount: -10, description: 'SYNTHETIC pending' }]; await request('/banking/sync', {});
      assert.equal((await db.bankAccount.findUniqueOrThrow({ where: { id: account._id } })).pending instanceof Array, true);
      assert.equal(await db.bankTransaction.count(), 2);
      pendingItems = []; posted.push(txn('trans_synthetic_posted_pending', -10)); await request('/banking/sync', {});
      assert.deepEqual((await db.bankAccount.findUniqueOrThrow({ where: { id: account._id } })).pending, []); assert.equal(await db.bankTransaction.count(), 3);
    });
    const usd = await invoice('TEST100', 'USD', 100, true), nzd = await invoice('TEST200', 'NZD', 100), nzd2 = await invoice('TEST201', 'NZD', 50);
    await t.test('suggestions expose evidence and ambiguous identical matches; nothing auto-confirms', async () => {
      await invoice('TEST100', 'USD', 100, true);
      const m = (await request('/banking/transactions/trans_synthetic_1/suggestions')).json(); assert.equal(m.ambiguous, true); assert.ok(m.suggestions[0].evidence.some((e: string) => e.includes('Invoice number')));
      assert.equal(await db.bankAllocation.count(), 0); assert.equal(await db.invoicePayment.count({ where: { bankAllocationId: { not: null } } }), 0);
      const falseSubstring = matchEvidence({ description: 'TEST1000', references: {}, amount: -1, currency: 'NZD', date: new Date() }, { invoiceNumber: 'TEST100', currency: 'USD', supplier: {}, bankAllocations: [] }); assert.ok(!falseSubstring.evidence.some(e => e.startsWith('Invoice number')));
    });
    let allocationId = '';
    await t.test('foreign principal, fees and FX difference are separate; approved stock snapshot is unchanged', async () => {
      const before = await db.supplierInvoice.findUniqueOrThrow({ where: { id: usd.id } });
      const body = { revision: 1, confirmed: true, note: 'Synthetic evidence checked', lines: [{ invoiceId: usd.id, invoiceVersion: usd.version, originalAmount: '100', amountNzd: '163', feeNzd: '2' }] };
      await request('/banking/transactions/trans_synthetic_1/allocate', { ...body, confirmed: false }, 400);
      const key = randomUUID(), result = (await request('/banking/transactions/trans_synthetic_1/allocate', body, 200, 'POST', key)).json(); allocationId = result.allocationIds[0];
      await request('/banking/transactions/trans_synthetic_1/allocate', body, 200, 'POST', key);
      assert.equal(await db.bankAllocation.count({ where: { transactionId: 'trans_synthetic_1' } }), 1);
      const a = await db.bankAllocation.findUniqueOrThrow({ where: { id: allocationId } }); assert.equal(a.expectedNzd?.toString(), '160'); assert.equal(a.exchangeDifferenceNzd?.toString(), '3'); assert.equal(a.feeNzd.toString(), '2');
      assert.equal((await db.invoicePayment.findUniqueOrThrow({where:{bankAllocationId:a.id}})).paidAt.toISOString().slice(0,10),'2026-03-10');
      const after = await db.supplierInvoice.findUniqueOrThrow({ where: { id: usd.id } }); assert.equal(after.fxRate?.toString(), before.fxRate?.toString()); assert.deepEqual(after.nzdSnapshot, before.nzdSnapshot);
      await request('/banking/transactions/trans_synthetic_1/allocate', body, 409);
    });
    await t.test('partial and grouped payments enforce remaining debit and original balances under concurrency', async () => {
      const base = { revision: 1, confirmed: true, note: 'Synthetic grouped remittance' };
      await request('/banking/transactions/trans_synthetic_2/allocate', { ...base, lines: [{ invoiceId: nzd.id, invoiceVersion: nzd.version, originalAmount: '40', amountNzd: '40', feeNzd: '0' }] });
      await request('/banking/transactions/trans_synthetic_2/allocate', { ...base, lines: [{ invoiceId: nzd.id, invoiceVersion: nzd.version, originalAmount: '60', amountNzd: '60', feeNzd: '0' }, { invoiceId: nzd2.id, invoiceVersion: nzd2.version, originalAmount: '50', amountNzd: '50', feeNzd: '0' }] });
      const r = (await request('/banking/transactions')).json().rows.find((x: any) => x.id === 'trans_synthetic_2'); assert.equal(r.unallocatedNzd, '0.00');
      const small = await invoice('SMALL', 'NZD', 100); const payload = { ...base, lines: [{ invoiceId: small.id, invoiceVersion: small.version, originalAmount: '10', amountNzd: '10', feeNzd: '0' }] };
      const sends = await Promise.all([1, 2].map(() => app.inject({ method: 'POST', url: '/api/banking/transactions/trans_synthetic_posted_pending/allocate', headers: { cookie, origin: process.env.WEB_ORIGIN!, 'content-type': 'application/json', 'idempotency-key': randomUUID() }, payload })));
      assert.deepEqual(sends.map(r => r.statusCode).sort(), [200, 409]);
      assert.equal((await db.supplierInvoice.findUniqueOrThrow({ where: { id: nzd.id } })).status, 'REVIEW');
    });
    await t.test('deleted/replaced provider ID blocks new allocation until audited reversal', async () => {
      posted = posted.filter(x => x._id !== 'trans_synthetic_1'); posted.push(txn('trans_synthetic_replacement', -165)); await request('/banking/sync', {});
      const removed = await db.bankTransaction.findUniqueOrThrow({ where: { id: 'trans_synthetic_1' } }); assert.equal(removed.status, 'REMOVED'); assert.equal(removed.reviewRequired, true);
      const body = { revision: 1, confirmed: true, note: 'Synthetic replacement', lines: [{ invoiceId: usd.id, invoiceVersion: usd.version, originalAmount: '100', amountNzd: '163', feeNzd: '2' }] };
      await request('/banking/transactions/trans_synthetic_replacement/allocate', body, 409);
      await request('/banking/allocations/' + allocationId + '/reverse', { reason: 'Provider replaced this synthetic transaction' });
      const oldPayment = await db.invoicePayment.findUniqueOrThrow({ where: { bankAllocationId: allocationId } }); assert.ok(oldPayment.reversedAt);
      await request('/banking/transactions/trans_synthetic_replacement/allocate', body);
      await assert.rejects(db.bankAllocation.update({ where: { id: allocationId }, data: { amountNzd: 1 } }), /immutable/);
      await assert.rejects(db.bankAllocation.delete({ where: { id: allocationId } }), /retained for audit/);
    });
    await t.test('separate fee debit and cancelled scans cannot duplicate principal',async()=>{
      posted.push(txn('trans_synthetic_fee',-5)); await request('/banking/sync',{});
      const body={revision:1,confirmed:true,note:'Synthetic separate fee',lines:[{invoiceId:usd.id,invoiceVersion:usd.version,originalAmount:'0',amountNzd:'0',feeNzd:'5'}]};
      await startBankSync(db); await request('/banking/sync/cancel',{}); await request('/banking/transactions/trans_synthetic_fee/allocate',body,409);
      await request('/banking/sync',{}); const result=(await request('/banking/transactions/trans_synthetic_fee/allocate',body)).json();
      const a=await db.bankAllocation.findUniqueOrThrow({where:{id:result.allocationIds[0]}}); assert.equal(a.amountNzd.toString(),'0'); assert.equal(a.feeNzd.toString(),'5'); assert.equal(a.expectedNzd?.toString(),'0');
    });
    await t.test('material changes to reconciled transactions require review; identical reimports do not',async()=>{
      posted=posted.map(x=>x._id==='trans_synthetic_2'?{...x,amount:-151}:x); await request('/banking/sync',{});
      const changed=await db.bankTransaction.findUniqueOrThrow({where:{id:'trans_synthetic_2'}}); assert.equal(changed.reviewRequired,true);
      await request('/banking/sync',{}); assert.equal((await db.bankTransaction.findUniqueOrThrow({where:{id:changed.id}})).revision,changed.revision);
    });
    await t.test('manual refresh cooldown and HTTP 429 backoff persist', async () => {
      await requestBankRefresh(db); assert.equal(refreshes, 1);
      await assert.rejects(requestBankRefresh(db), /cooling down/);
      await db.bankFeed.update({ where: { id: 'akahu' }, data: { nextRequestAt: null } }); statusCode = 429;
      await assert.rejects(loadBankAccounts(db), /rate limit/); const f = await db.bankFeed.findUniqueOrThrow({ where: { id: 'akahu' } }); assert.ok(f.nextRequestAt!.getTime() > Date.now() + 60000);
      statusCode = 200; await db.bankFeed.update({ where: { id: 'akahu' }, data: { nextRequestAt: null } });
    });
    await t.test('401 discards revoked token without signing out ERP; disconnect retry retains token securely', async () => {
      statusCode = 503; await request('/banking/disconnect', {}, 502); assert.equal((await readConnection(db, 'AKAHU')).accessToken, token);
      assert.equal((await db.bankFeed.findUniqueOrThrow({ where: { id: 'akahu' } })).status, 'DISCONNECT_FAILED');
      statusCode = 401; await request('/banking/disconnect', {}); assert.equal((await readConnection(db, 'AKAHU')).accessToken, undefined);
      assert.equal((await request('/auth/me')).json().id, admin.id);
      // Re-authorise, then simulate external token revocation during a read.
      statusCode = 200; const r = await request('/banking/authorize', {}), state = new URL(r.json().url).searchParams.get('state')!;
      assert.equal((await app.inject({ method: 'GET', url: '/api/banking/callback?state=' + state + '&code=synthetic', headers: { cookie: 'erp_bank_oauth=' + state } })).statusCode, 302);
      statusCode = 401; await request('/banking/accounts/discover', {}, 502); assert.equal((await db.bankFeed.findUniqueOrThrow({ where: { id: 'akahu' } })).status, 'REAUTHORIZE'); assert.equal((await readConnection(db, 'AKAHU')).accessToken, undefined);
    });
    await t.test('approved internal app is account-bound, read-only, encrypted and requires repeat imports before daily scheduling', async()=>{
      statusCode=200;
      await request('/banking/internal-personal',{appId,userToken:token,since:'2026-03-01'},409);
      process.env.AKAHU_INTERNAL_APPROVED='true';
      process.env.AKAHU_INTERNAL_APP_SHA256=createHash('sha256').update(appId).digest('hex');
      process.env.AKAHU_INTERNAL_ACCOUNT_ID=account._id;
      assert.throws(()=>bankingGate('PERSONAL_TEST'),/isolated/);
      await request('/banking/internal-personal',{appId:'app_token_wrong',userToken:token,since:'2026-03-01'},409);
      await request('/banking/internal-personal',{appId,userToken:token,since:'2026-03-01'});
      const c=await readConnection(db,'AKAHU');assert.equal(c.kind,'INTERNAL_PERSONAL');
      const publicStatus=(await request('/banking/status')).body;
      for(const value of [appId,token])assert.ok(!publicStatus.includes(value));
      assert.equal(bankSyncInterval('INTERNAL_PERSONAL'),86400000);
      const before=calls.length;
      await assert.rejects(akahuRequest(c,'/refresh/'+account._id,'POST'),/cached reads only/);
      await assert.rejects(akahuRequest(c,'/accounts/acc_other/transactions'),/allowlist/);
      assert.equal(calls.length,before);
      await request('/banking/accounts/discover',{});
      await request('/banking/accounts/select',{ids:['acc_inactive'],autoSync:false},400);
      await request('/banking/accounts/select',{ids:[account._id],autoSync:true},409);
      await request('/banking/accounts/select',{ids:[account._id],autoSync:false});
      const allocations=await db.bankAllocation.count();
      await request('/banking/sync',{});
      const imported=await db.bankTransaction.findMany({orderBy:{id:'asc'},select:{id:true,amount:true,date:true,revision:true}});
      await request('/banking/sync',{});
      assert.deepEqual(await db.bankTransaction.findMany({orderBy:{id:'asc'},select:{id:true,amount:true,date:true,revision:true}}),imported);
      assert.equal(await db.bankAllocation.count(),allocations);
      await request('/banking/accounts/select',{ids:[account._id],autoSync:true});
      assert.equal((await request('/banking/status')).json().autoSync,true);
      const remote=await app.inject({method:'GET',url:'/api/banking/status',remoteAddress:'192.0.2.10',headers:{cookie}});assert.equal(remote.statusCode,403);
      const last=calls.length; await request('/banking/disconnect',{});
      assert.equal(calls.length,last);assert.equal(await readConnection(db,'AKAHU'),null);
      assert.equal((await request('/banking/status')).json().autoSync,false);
      delete process.env.AKAHU_INTERNAL_APPROVED;delete process.env.AKAHU_INTERNAL_APP_SHA256;delete process.env.AKAHU_INTERNAL_ACCOUNT_ID;
    });
    await t.test('non-admin users cannot read bank data or confirm allocations', async () => {
      statusCode = 200; const user = await db.user.create({ data: { email: prefix + '-viewer@test.invalid', name: 'Synthetic viewer', role: 'VIEWER', passwordHash: hashPassword('synthetic-password-123') } });
      cookie = String((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: user.email, password: 'synthetic-password-123' } })).headers['set-cookie']).split(';')[0]; await request('/banking/status', undefined, 403);
      await request('/banking/transactions/trans_synthetic_1/allocate', {}, 403);
    });
    assert.ok(calls.every(c => !c.includes('/payments')));
  } finally { globalThis.fetch = originalFetch; await app.close(); await db.$disconnect(); }
});
