import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHmac } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { buildApp } from '../apps/api/src/app.js';
import { hashPassword } from '../apps/api/src/auth.js';

// Tests only add isolated fixtures to an explicitly named test database/schema.
assert.match(process.env.DATABASE_URL ?? '', /(?:_test|schema=erp_test)/, 'Use a dedicated test database');
process.env.NODE_ENV = 'test'; process.env.WEB_ORIGIN = 'http://localhost:5173'; process.env.ERP_TEST_MODE = 'true';
const db = new PrismaClient(), prefix = 't' + Date.now(), password = 'test-only-password-123';
const app = await buildApp(db, false);
let cookie = '';
async function call(path: string, body?: any, status = 200, key = randomUUID(), method = 'POST') {
  const r = await app.inject({ method: body === undefined ? 'GET' : method as any, url: '/api' + path, headers: { cookie, origin: process.env.WEB_ORIGIN!, ...(body === undefined ? {} : { 'content-type': 'application/json', 'idempotency-key': key }) }, payload: body });
  assert.equal(r.statusCode, status, `${path}: ${r.body}`); return r.json();
}
await test('Godmode operational workflow and integrity', async t => {
  const admin = await db.user.create({ data: { email: `${prefix}@test.invalid`, name: 'Test admin', passwordHash: hashPassword(password), role: 'ADMIN' } });
  let family: any, cpu: any, ram: any, loc: any, other: any, product: any, bom: any, po: any, build: any, unit: any;
  await t.test('unauthenticated and incorrect login requests are denied', async () => {
    await call('/inventory', undefined, 401);
    await call('/auth/login', { email: admin.email, password: 'wrong' }, 401);
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: admin.email, password } }); assert.equal(r.statusCode, 200); cookie = String(r.headers['set-cookie']).split(';')[0]; assert.match(cookie, /^godmode_session=/);
  });
  await t.test('catalogue, serialized components and BOM creation', async () => {
    family = await call('/component-families', { name: prefix + ' components', category: 'TEST' });
    cpu = await call('/skus', { code: prefix + '-CPU', name: 'Serialized CPU', familyId: family.id, trackingMode: 'SERIALIZED', barcodes: [prefix + '-BARCODE'] });
    ram = await call('/skus', { code: prefix + '-RAM', name: 'Quantity RAM', familyId: family.id, trackingMode: 'QUANTITY', reorderPoint: 2 });
    loc = await call('/locations', { code: prefix + '-MAIN', name: 'Test main' }); other = await call('/locations', { code: prefix + '-OTHER', name: 'Test second location' });
    product = await call('/products', { code: prefix + '-PC', name: 'Test PC' });
    bom = await call(`/products/${product.id}/bom-versions`, { lines: [{ role: 'CPU', quantity: 1, exactSkuId: cpu.id }, { role: 'RAM', quantity: 2, exactSkuId: ram.id }] });
    await call(`/products/${product.id}/bom-versions`, { lines: [{ role: 'CPU', quantity: 1 }] }, 400);
    assert.equal((await call(`/barcodes/${prefix}-BARCODE`)).sku.id, cpu.id);
  });
  await t.test('receipt validation, idempotency and append-only ledger', async () => {
    await call('/inventory/receipts', { skuId: cpu.id, locationId: loc.id, quantity: 1, unitCost: 200, serialNumbers: [] }, 400);
    const request = { skuId: ram.id, locationId: loc.id, quantity: 10, unitCost: 50, serialNumbers: [] }, key = randomUUID();
    const first = await call('/inventory/receipts', request, 200, key); const replay = await call('/inventory/receipts', request, 200, key); assert.equal(first.id, replay.id);
    await call('/inventory/receipts', { ...request, quantity: 11 }, 409, key);
    assert.equal((await call('/inventory')).find((r: any) => r.skuId === ram.id && r.locationId === loc.id).onHand, 10);
    await assert.rejects(() => db.inventoryTransaction.update({ where: { id: first.id }, data: { quantityDelta: 100 } }), /append-only/);
    await db.$disconnect(); await db.$connect(); // Reset the connection after a deliberate database-level exception.
  });
  await t.test('purchase order lifecycle and partial receipts prevent over-receiving', async () => {
    const supplier = await call('/suppliers', { code: prefix + '-SUP', name: 'Test supplier' });
    await call(`/suppliers/${supplier.id}/skus/${cpu.id}`, { unitCost: 200, preferred: true }, 200, randomUUID(), 'PUT');
    po = await call('/purchase-orders', { number: prefix + '-PO', supplierId: supplier.id, lines: [{ skuId: cpu.id, quantityOrdered: 2, unitCost: 200 }] });
    const receipt = { locationId: loc.id, lines: [{ lineId: po.lines[0].id, quantity: 1, serialNumbers: [prefix + '-SN1'] }] };
    await call(`/purchase-orders/${po.id}/receive`, receipt, 409);
    await call(`/purchase-orders/${po.id}/order`, {});
    await call(`/purchase-orders/${po.id}/receive`, { ...receipt, lines: [...receipt.lines, ...receipt.lines] }, 400);
    const partial = await call(`/purchase-orders/${po.id}/receive`, receipt); assert.equal(partial.status, 'PARTIALLY_RECEIVED');
    await call(`/purchase-orders/${po.id}/receive`, { ...receipt, lines: [{ lineId: po.lines[0].id, quantity: 2, serialNumbers: [prefix + '-SN2', prefix + '-SN3'] }] }, 409);
    await call(`/purchase-orders/${po.id}/receive`, receipt, 409); // duplicate physical serial rolls back all mutations
    const complete = await call(`/purchase-orders/${po.id}/receive`, { ...receipt, lines: [{ lineId: po.lines[0].id, quantity: 1, serialNumbers: [prefix + '-SN2'] }] }); assert.equal(complete.status, 'RECEIVED');
    assert.equal((await call('/inventory')).find((r: any) => r.skuId === cpu.id && r.locationId === loc.id).onHand, 2);
  });
  await t.test('reservation holds stock without consuming it; repeated reservations remain exact', async () => {
    build = await call('/builds', { buildNumber: prefix + '-BUILD', productId: product.id, bomVersionId: bom.id });
    await call(`/builds/${build.id}/reserve`, { locationId: loc.id }); await call(`/builds/${build.id}/reserve`, { locationId: loc.id });
    const r = (await call('/inventory')).find((x: any) => x.skuId === ram.id && x.locationId === loc.id); assert.deepEqual([r.onHand, r.reserved, r.available], [10, 2, 8]);
    await call('/inventory/adjustments', { skuId: ram.id, locationId: loc.id, quantityDelta: -9, reason: 'Cannot remove held stock' }, 409);
    await call(`/builds/${build.id}/complete`, { unitNumber: prefix + '-UNIT' }, 409);
  });
  await t.test('concurrent requests cannot reserve the same final serial twice', async () => {
    const a = await call('/builds', { buildNumber: prefix + '-RACE1', productId: product.id, bomVersionId: bom.id }); const b = await call('/builds', { buildNumber: prefix + '-RACE2', productId: product.id, bomVersionId: bom.id });
    const results = await Promise.all([a, b].map(x => app.inject({ method: 'POST', url: `/api/builds/${x.id}/reserve`, headers: { cookie, origin: process.env.WEB_ORIGIN!, 'idempotency-key': randomUUID() }, payload: { locationId: loc.id } })));
    assert.deepEqual(results.map(r => r.statusCode).sort(), [200, 409]);
    for (const x of [a, b]) await call(`/builds/${x.id}/cancel`, { reason: 'Race test complete' });
  });
  await t.test('QA gate, transactional completion, serial genealogy and costs', async () => {
    await call(`/builds/${build.id}/start`, {});
    await call(`/builds/${build.id}/complete`, { unitNumber: prefix + '-UNIT' }, 409);
    const checks = { hardware: true, memory: false, storage: true, thermals: true, windows: true, cosmetic: true };
    await call(`/builds/${build.id}/qa`, { checks }); await call(`/builds/${build.id}/complete`, { unitNumber: prefix + '-UNIT' }, 409);
    checks.memory = true; await call(`/builds/${build.id}/qa`, { checks });
    const key = randomUUID(); unit = await call(`/builds/${build.id}/complete`, { unitNumber: prefix + '-UNIT' }, 200, key); assert.equal((await call(`/builds/${build.id}/complete`, { unitNumber: prefix + '-UNIT' }, 200, key)).id, unit.id);
    await call(`/builds/${build.id}/complete`, { unitNumber: prefix + '-SECOND' }, 409);
    const full = await call(`/units/${unit.unitNumber}`); assert.equal(full.components.find((c: any) => c.role === 'CPU').serialNumber, prefix + '-SN1'); assert.equal(full.components.reduce((n: number, c: any) => n + Number(c.unitCost) * c.quantity, 0), 300);
    const stock = (await call('/inventory')).find((r: any) => r.skuId === cpu.id && r.locationId === loc.id); assert.deepEqual([stock.onHand, stock.reserved, stock.available], [1, 0, 1]);
  });
  await t.test('service blocks dispatch until resolved, dispatch records once', async () => {
    const ticket = await call('/repairs', { number: prefix + '-RMA', unitId: unit.id, issue: 'Test cosmetic issue' });
    await call(`/units/${unit.id}/dispatch`, { carrier: 'Test courier', trackingNumber: 'TRACK' }, 409);
    await call(`/repairs/${ticket.id}`, { status: 'CLOSED' }, 400, randomUUID(), 'PATCH');
    await call(`/repairs/${ticket.id}`, { status: 'CLOSED', resolution: 'Checked and resolved' }, 200, randomUUID(), 'PATCH');
    await call(`/units/${unit.id}/dispatch`, { carrier: 'Test courier', trackingNumber: 'TRACK' });
    await call(`/units/${unit.id}/dispatch`, { carrier: 'Test courier', trackingNumber: 'TRACK' }, 409);
  });
  await t.test('stock transfer moves both ledger and serial location atomically', async () => {
    await call('/inventory/transfers', { skuId: cpu.id, fromLocationId: loc.id, toLocationId: other.id, quantity: 1, serialNumbers: [prefix + '-SN2'], reason: 'Move shelf' });
    const rows = await call('/inventory'); assert.equal(rows.find((r: any) => r.skuId === cpu.id && r.locationId === loc.id).onHand, 0); assert.equal(rows.find((r: any) => r.skuId === cpu.id && r.locationId === other.id).onHand, 1);
    assert.equal((await call(`/inventory/units?skuId=${cpu.id}&available=true`))[0].locationId, other.id);
  });
  await t.test('Shopify paid intake is retryable without duplicate builds; shared SKU dry run counts demand', async () => {
    await call('/shopify/mappings', { sku: prefix + '-SHOP', productId: product.id });
    const payload = { id: prefix + '-ORDER', name: '#' + prefix, financial_status: 'paid', total_price: '1000.00', line_items: [{ id: 1, sku: prefix + '-SHOP', title: 'Test PC', quantity: 1 }] };
    const first = await call('/integrations/shopify/test-order', { shopDomain: 'test.myshopify.com', order: payload });
    const again = await call('/integrations/shopify/test-order', { shopDomain: 'test.myshopify.com', order: payload }); assert.deepEqual(first.lines[0].buildIds, again.lines[0].buildIds); assert.equal(first.lines[0].buildIds.length, 1);
    const dry = await call('/integrations/shopify/dry-run', { shopDomain: 'test.myshopify.com', locationId: other.id, order: { ...payload, line_items: [payload.line_items[0], { ...payload.line_items[0], id: 2 }] } }); assert.equal(dry.status, 'BLOCKED');
    await call('/integrations/shopify/test-order', { shopDomain: 'test.myshopify.com', order: { ...payload, id: prefix + '-UNPAID', financial_status: 'pending' } }, 409);
    assert.equal(await db.salesOrder.count({ where: { externalId: prefix + '-UNPAID' } }), 0);
    const changed = await call('/integrations/shopify/test-order', { shopDomain: 'test.myshopify.com', order: { ...payload, line_items: [{ ...payload.line_items[0], quantity: 2 }] } }); assert.equal(changed.status, 'BLOCKED'); assert.equal(changed.lines[0].buildIds.length, 1); assert.match(changed.lines[0].resolutionMessage, /changed/);
  });
  await t.test('webhook signature, failed-event retry and duplicate event processing', async () => {
    process.env.ERP_TEST_MODE = 'false'; process.env.SHOPIFY_WEBHOOK_SECRET = 'test-webhook-secret'; process.env.SHOPIFY_STORE_DOMAIN = 'test.myshopify.com';
    const payload = { id: prefix + '-HOOK', financial_status: 'paid', line_items: [{ id: 1, sku: prefix + '-SHOP', quantity: 1 }] };
    const raw = JSON.stringify(payload), eventId = prefix + '-EVENT';
    const headers = { 'content-type': 'application/json', 'x-shopify-shop-domain': 'test.myshopify.com', 'x-shopify-webhook-id': eventId, 'x-shopify-hmac-sha256': createHmac('sha256', 'test-webhook-secret').update(raw).digest('base64') };
    const bad = await app.inject({ method: 'POST', url: '/api/integrations/shopify/webhooks/orders-paid', headers: { ...headers, 'x-shopify-hmac-sha256': 'bad' }, payload: raw }); assert.equal(bad.statusCode, 401);
    await db.integrationEvent.create({ data: { provider: 'SHOPIFY', externalEventId: eventId, topic: 'orders-paid', status: 'FAILED', error: 'Temporary test failure' } });
    const first = await app.inject({ method: 'POST', url: '/api/integrations/shopify/webhooks/orders-paid', headers, payload: raw }); assert.equal(first.statusCode, 200, first.body);
    const second = await app.inject({ method: 'POST', url: '/api/integrations/shopify/webhooks/orders-paid', headers, payload: raw }); assert.equal(second.json().deduplicated, true);
    const savedEvent = await db.integrationEvent.findUniqueOrThrow({ where: { provider_externalEventId: { provider: 'SHOPIFY', externalEventId: eventId } } });
    assert.equal(savedEvent.shopDomain, 'test.myshopify.com');
    await db.integrationEvent.update({ where: { id: savedEvent.id }, data: { status: 'FAILED' } });
    delete process.env.SHOPIFY_STORE_DOMAIN;
    await call('/integrations/events/' + savedEvent.id + '/retry', {});
    process.env.SHOPIFY_STORE_DOMAIN = 'test.myshopify.com';
    process.env.ERP_TEST_MODE = 'true';
  });
  await t.test('read-only role, cross-origin writes and anonymous factory access are denied', async () => {
    const badOrigin = await app.inject({ method: 'POST', url: '/api/locations', headers: { cookie, origin: 'https://untrusted.invalid', 'idempotency-key': randomUUID() }, payload: { code: 'EVIL', name: 'Wrong origin' } }); assert.equal(badOrigin.statusCode, 403);
    const factory = await app.inject({ url: '/api/factory/builds/ready' }); assert.equal(factory.statusCode, 401);
    await call('/users', { email: `${prefix}-viewer@test.invalid`, name: 'Viewer', password, role: 'VIEWER' });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: `${prefix}-viewer@test.invalid`, password } }); cookie = String(login.headers['set-cookie']).split(';')[0];
    await call('/inventory'); await call('/locations', { code: prefix + '-DENY', name: 'Denied' }, 403); await call('/users', undefined, 403);
  });
});
await app.close(); await db.$disconnect();
