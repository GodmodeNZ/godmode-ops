import { localShopifyConfig } from './shopify-local.js';
import { shopifyGraphql, shopifyConfig } from './shopify-client.js';
export { shopifyGraphql } from './shopify-client.js';
import type { FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { ensure, json, mutate, syncOrderStatuses, transaction, type Tx } from './core.js';
import { createBuild } from './production.js';
import { orderSchema, resolveOrder, upsertOrder, verifyShopifyHmac } from './shopify.js';
import { dryRunShopifyOrder } from './shopify-dry-run.js';
const text = z.string().trim().min(1).max(200);
export const ordersQuery = `query OpsOrders($after: String) {
 orders(first: 25, after: $after, query: "financial_status:paid fulfillment_status:unfulfilled", sortKey: CREATED_AT, reverse: true) {
  nodes { id name createdAt cancelledAt displayFinancialStatus displayFulfillmentStatus email
   currentTotalPriceSet { shopMoney { amount currencyCode } }
   customer { firstName lastName defaultEmailAddress { emailAddress } }
   lineItems(first: 100) { nodes { id name sku quantity customAttributes { key value } product { id } variant { id } } pageInfo { hasNextPage } }
  } pageInfo { hasNextPage endCursor }
 }
}`;
async function cancelOrder(tx: Tx, id: string) {
  const order = await tx.salesOrder.findUniqueOrThrow({ where: { id }, include: { lines: true } });
  for (const line of order.lines) {
    const builds = await tx.build.findMany({ where: { id: { in: line.buildIds } } });
    for (const build of builds) if (['CREATED', 'RESERVED'].includes(build.status)) {
      await tx.inventoryReservation.updateMany({ where: { buildId: build.id, status: 'ACTIVE' }, data: { status: 'RELEASED' } });
      await tx.build.update({ where: { id: build.id }, data: { status: 'CANCELLED', events: { create: { type: 'ORDER_CANCELLED' } } } });
    } else if (build.status !== 'CANCELLED') await tx.buildEvent.create({ data: { buildId: build.id, type: 'ORDER_CANCELLED_REVIEW_REQUIRED' } });
  }
  return tx.salesOrder.update({ where: { id }, data: { status: 'CANCELLED' } });
}
export async function registerIntegrations(app: FastifyInstance, db: PrismaClient) {
  app.get('/sales-orders', async () => db.salesOrder.findMany({ include: { lines: true }, orderBy: { createdAt: 'desc' }, take: 2000 }));
  app.post('/sales-orders', async q => {
    const b = z.object({ orderNumber: text, customerName: text, customerEmail: z.string().email().optional(), total: z.number().nonnegative(), lines: z.array(z.object({ productId: text, quantity: z.number().int().positive().max(100) })).min(1) }).parse(q.body);
    return mutate(db, q, 'Create manual paid order', async tx => {
      const order = await tx.salesOrder.create({ data: { source: 'MANUAL', externalId: b.orderNumber, orderNumber: b.orderNumber, customerName: b.customerName, customerEmail: b.customerEmail, total: b.total, currency: 'NZD', financialStatus: 'paid' } });
      for (const [index, line] of b.lines.entries()) { const product = await tx.product.findUniqueOrThrow({ where: { id: line.productId } }); await tx.salesOrderLine.create({ data: { salesOrderId: order.id, externalLineId: String(index + 1), title: product.name, resolvedProductId: product.id, quantity: line.quantity } }); }
      return resolveOrder(tx, order.id);
    });
  });
  app.patch('/sales-orders/:id/lines/:lineId', async q => {
    const { id, lineId } = q.params as { id: string; lineId: string }; const { productId } = z.object({ productId: text }).parse(q.body);
    return mutate(db, q, 'Map order line', async tx => { const line = await tx.salesOrderLine.findUniqueOrThrow({ where: { id: lineId } }); ensure(line.salesOrderId === id && !line.buildIds.length, 'Only unresolved lines without builds can be remapped'); await tx.product.findUniqueOrThrow({ where: { id: productId } }); return tx.salesOrderLine.update({ where: { id: lineId }, data: { resolvedProductId: productId, status: 'UNRESOLVED', resolutionMessage: null } }); });
  });
  app.post('/sales-orders/:id/resolve', async q => { const { id } = q.params as { id: string }; const b = z.object({ locationId: text.optional() }).parse(q.body ?? {}); return mutate(db, q, 'Resolve order', tx => resolveOrder(tx, id, b.locationId)); });
  app.post('/sales-orders/:id/cancel', async q => { const { id } = q.params as { id: string }; return mutate(db, q, 'Cancel ERP order', tx => cancelOrder(tx, id)); });
  app.get('/shopify/mappings', async () => db.shopifyProductMapping.findMany({ where: { active: true }, include: { product: true, configurationRules: { include: { replacementSku: true } } }, orderBy: { priority: 'asc' } }));
  app.post('/shopify/mappings', async q => {
    const b = z.object({ shopDomain: text.optional(), shopifyProductId: text.optional(), shopifyVariantId: text.optional(), sku: text.optional(), productId: text, priority: z.number().int().min(0).max(999).default(100), configurationRules: z.array(z.object({ propertyName: text, propertyValue: text, role: text, replacementSkuId: text, quantity: z.number().int().positive().optional() })).default([]) }).parse(q.body);
    ensure(b.shopifyProductId || b.shopifyVariantId || b.sku, 'Provide a product ID, variant ID or SKU', 400);
    return mutate(db, q, 'Create Shopify mapping', async tx => {
      const bom = await tx.bomVersion.findFirst({ where: { productId: b.productId, active: true }, orderBy: { version: 'desc' }, include: { lines: true } });
      ensure(b.configurationRules.every(r => bom?.lines.some(l => l.role === r.role)), 'Every rule must match a role in the product BOM', 400);
      return tx.shopifyProductMapping.create({ data: { ...b, shopDomain: b.shopDomain ?? process.env.SHOPIFY_STORE_DOMAIN, configurationRules: { create: b.configurationRules } } });
    });
  });
  app.delete('/shopify/mappings/:id', async q => { const { id } = q.params as { id: string }; return mutate(db, q, 'Disable Shopify mapping', tx => tx.shopifyProductMapping.update({ where: { id }, data: { active: false } })); });
  app.get('/integrations/status', async () => { const saved = await db.integrationConnection.findUnique({ where: { provider: 'SHOPIFY' }, select: { metadata: true } }); const meta = (saved?.metadata ?? localShopifyConfig()) as any; return ({ shopify: { configured: Boolean(saved || meta || (process.env.SHOPIFY_STORE_DOMAIN && (process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || process.env.SHOPIFY_CLIENT_SECRET))), domain: meta?.domain ?? process.env.SHOPIFY_STORE_DOMAIN ?? null, verifiedAt: meta?.verifiedAt ?? null, webhookConfigured: Boolean(process.env.SHOPIFY_WEBHOOK_SECRET) }, factoryConfigured: Boolean(process.env.FACTORY_API_TOKEN), testMode: process.env.ERP_TEST_MODE === 'true', events: await db.integrationEvent.findMany({ select: { id: true, topic: true, status: true, error: true, createdAt: true, processedAt: true }, orderBy: { createdAt: 'desc' }, take: 50 }) }); });
  app.post('/integrations/shopify/dry-run', async q => { const b = z.object({ shopDomain: text.optional(), order: orderSchema, locationId: text.optional() }).parse(q.body); return dryRunShopifyOrder(db, b.order, b.shopDomain, b.locationId); });
  app.post('/integrations/shopify/test-order', async q => { ensure(process.env.ERP_TEST_MODE === 'true', 'Test order import is disabled outside the test environment', 403); const b = z.object({ order: orderSchema, shopDomain: text.optional(), locationId: text.optional() }).parse(q.body); return mutate(db, q, 'Import test order', async tx => { const o = await upsertOrder(tx, b.order, b.shopDomain); return resolveOrder(tx, o.id, b.locationId); }); });
  app.post('/integrations/shopify/sync', async q => {
    ensure(process.env.ERP_TEST_MODE !== 'true', 'Live order import is disabled in the test environment', 403);
    const { locationId } = z.object({ locationId: text.optional() }).parse(q.body ?? {});
    let after: string | null = null; const payloads: any[] = []; const config = await shopifyConfig(db);
    do {
      const data = await shopifyGraphql(ordersQuery, { after }, db);
      for (const o of data.orders.nodes) {
        ensure(!o.lineItems.pageInfo.hasNextPage, `${o.name} has more than 100 lines and needs a dedicated import`, 409);
        const number = (gid: string | undefined) => gid?.split('/').pop();
        payloads.push({ id: number(o.id), name: o.name, created_at: o.createdAt, cancelled_at: o.cancelledAt, financial_status: o.displayFinancialStatus?.toLowerCase(), fulfillment_status: o.displayFulfillmentStatus?.toLowerCase(), email: o.email, customer: o.customer ? { first_name: o.customer.firstName, last_name: o.customer.lastName, email: o.customer.defaultEmailAddress?.emailAddress } : undefined, currency: o.currentTotalPriceSet.shopMoney.currencyCode, total_price: o.currentTotalPriceSet.shopMoney.amount, line_items: o.lineItems.nodes.map((l: any) => ({ id: number(l.id), title: l.name, sku: l.sku, product_id: number(l.product?.id), variant_id: number(l.variant?.id), quantity: l.quantity, properties: l.customAttributes.map((p: any) => ({ name: p.key, value: p.value })) })) });
      }
      after = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null;
      ensure(payloads.length <= 2000, 'More than 2,000 open orders; narrow the import window', 409);
    } while (after);
    return mutate(db, q, 'Import Shopify open paid orders', async tx => { for (const payload of payloads) { const o = await upsertOrder(tx, payload, config.domain); if (payload.cancelled_at) await cancelOrder(tx, o.id); else if (o.status !== 'CANCELLED') await resolveOrder(tx, o.id, locationId); } return { imported: payloads.length }; });
  });
  for (const topic of ['orders-paid', 'orders-cancelled', 'orders-updated']) app.post(`/integrations/shopify/webhooks/${topic}`, { config: { rawBody: true } }, async (q, r) => {
    ensure(process.env.ERP_TEST_MODE !== 'true', 'Live webhooks are disabled in the test environment', 403);
    const raw = (q as any).rawBody as Buffer | undefined;
    ensure(raw && verifyShopifyHmac(raw, q.headers['x-shopify-hmac-sha256'] as string, process.env.SHOPIFY_WEBHOOK_SECRET ?? ''), 'Invalid webhook signature', 401);
    const webhookDomain = process.env.SHOPIFY_STORE_DOMAIN ?? (await shopifyConfig(db)).domain;
    ensure(q.headers['x-shopify-shop-domain'] === webhookDomain, 'Unknown Shopify store', 401);
    const externalEventId = z.string().min(1).max(200).parse(q.headers['x-shopify-webhook-id']); const payload = orderSchema.parse(q.body);
    try {
      return await transaction(db, async tx => {
        const old = await tx.integrationEvent.findUnique({ where: { provider_externalEventId: { provider: 'SHOPIFY', externalEventId } } });
        if (old?.status === 'PROCESSED') return { ok: true, deduplicated: true };
        const o = await upsertOrder(tx, payload, webhookDomain);
        if (payload.cancelled_at || topic === 'orders-cancelled') await cancelOrder(tx, o.id);
        else if (payload.financial_status === 'paid' && o.status !== 'CANCELLED') await resolveOrder(tx, o.id, process.env.DEFAULT_INVENTORY_LOCATION_ID || undefined);
        else if (['refunded', 'voided'].includes(payload.financial_status ?? '')) await cancelOrder(tx, o.id);
        const data = { topic, shopDomain: webhookDomain, payload: json(payload), status: 'PROCESSED' as const, processedAt: new Date(), error: null };
        await tx.integrationEvent.upsert({ where: { provider_externalEventId: { provider: 'SHOPIFY', externalEventId } }, create: { provider: 'SHOPIFY', externalEventId, ...data }, update: data }); return { ok: true };
      });
    } catch (e) {
      await transaction(db, async tx => { const old = await tx.integrationEvent.findUnique({ where: { provider_externalEventId: { provider: 'SHOPIFY', externalEventId } } }); if (old?.status === 'PROCESSED') return; const data = { topic, payload: json(payload), status: 'FAILED' as const, error: (e as Error).message }; await tx.integrationEvent.upsert({ where: { provider_externalEventId: { provider: 'SHOPIFY', externalEventId } }, create: { provider: 'SHOPIFY', externalEventId, ...data }, update: data }); });
      return r.code(500).send({ error: 'Webhook could not be processed; Shopify can retry it' });
    }
  });
  app.post('/integrations/events/:id/retry', async q => { const { id } = q.params as { id: string }; return mutate(db, q, 'Retry integration event', async tx => { const e = await tx.integrationEvent.findUniqueOrThrow({ where: { id } }); ensure(e.status === 'FAILED', 'Only failed events can be retried'); const p = orderSchema.parse(e.payload), o = await upsertOrder(tx, p, process.env.SHOPIFY_STORE_DOMAIN); if (p.cancelled_at || e.topic === 'orders-cancelled') await cancelOrder(tx, o.id); else if (p.financial_status === 'paid') await resolveOrder(tx, o.id, process.env.DEFAULT_INVENTORY_LOCATION_ID || undefined); return tx.integrationEvent.update({ where: { id }, data: { status: 'PROCESSED', processedAt: new Date(), error: null } }); }); });
}
