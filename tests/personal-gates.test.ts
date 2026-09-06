import { test } from 'node:test';
import assert from 'node:assert/strict';
import { personalTestGate, personalTestWindow, bankingGate, akahuRequest } from '../apps/api/src/akahu-client.js';
import { requestBankRefresh } from '../apps/api/src/banking-sync.js';

test('Personal adapter rejects live databases, non-loopback servers, workers and all remote writes', async () => {
  const saved = { ...process.env }; const oldFetch = globalThis.fetch;
  try {
    Object.assign(process.env, { DATABASE_URL: 'postgresql://synthetic:fake@localhost/godmode_akahu_personal_test_123', AKAHU_PERSONAL_TEST: 'true', NODE_ENV: 'test', API_HOST: '127.0.0.1', WEB_ORIGIN: 'http://127.0.0.1:4001' });
    personalTestGate(); bankingGate('PERSONAL_TEST');
    for (const [key, bad] of Object.entries({ DATABASE_URL: 'postgresql://synthetic:fake@localhost/godmode_ops_test', NODE_ENV: 'production', API_HOST: '0.0.0.0', WEB_ORIGIN: 'http://localhost:4000', AKAHU_PERSONAL_TEST: 'false' })) {
      const original = process.env[key]; process.env[key] = bad; assert.throws(personalTestGate, /dedicated isolated/); process.env[key] = original;
    }
    assert.throws(() => bankingGate('SANDBOX'), /only supports/);
    assert.throws(() => bankingGate('PRODUCTION'), /only supports/);
    let reads = 0;
    globalThis.fetch = async (_url, options) => { assert.equal(options?.method, 'GET'); reads++; return new Response('{"success":true,"items":[]}'); };
    const c = { kind: 'PERSONAL_TEST', appId: 'app_token_fake', accessToken: 'user_token_fake' };
    for (const [path, method] of [['/token','POST'],['/token','DELETE'],['/refresh/acc_fake','POST'],['/payments','POST']]) await assert.rejects(akahuRequest(c, path, method), /cached reads only/);
    await assert.rejects(requestBankRefresh({} as any), /disabled/);
    await assert.rejects(akahuRequest({appId:'app_token_fake'}, '/accounts'), /cached reads only/);
    assert.equal(reads, 0); await akahuRequest(c, '/accounts'); assert.equal(reads, 1);
  } finally { globalThis.fetch = oldFetch; for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); }
});
test('Personal test windows are completed, ordered and no longer than seven days', () => {
  assert.equal(personalTestWindow('2026-03-01T00:00:00Z','2026-03-08T00:00:00Z').end.toISOString(),'2026-03-08T00:00:00.000Z');
  for (const [start,end] of [['bad','bad'],['2026-03-01','2026-03-09'],['2026-03-02','2026-03-01'],['2026-03-01','2026-03-01'],['2099-01-01','2099-01-02']]) assert.throws(() => personalTestWindow(start,end), /seven days/);
});
