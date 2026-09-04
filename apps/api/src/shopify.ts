import { createHmac, timingSafeEqual } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { ensure, json, position, syncOrderStatuses, transaction, type Tx } from './core.js';
import { createBuild, reserveBuild } from './production.js';
const external = z.union([z.string().min(1), z.number().int()]);
export const orderSchema = z.object({ id: external, name: z.string().optional(), order_number: external.optional(), financial_status: z.string().nullable().optional(), fulfillment_status: z.string().nullable().optional(), cancelled_at: z.string().nullable().optional(), currency: z.string().default('NZD'), total_price: z.string().regex(/^\d+(\.\d+)?$/).optional(), created_at: z.string().optional(), customer: z.object({ first_name: z.string().nullable().optional(), last_name: z.string().nullable().optional(), email: z.string().nullable().optional() }).nullable().optional(), email: z.string().nullable().optional(), line_items: z.array(z.object({ id: external, product_id: external.nullable().optional(), variant_id: external.nullable().optional(), sku: z.string().nullable().optional(), title: z.string().optional(), name: z.string().optional(), quantity: z.number().int().positive().max(100), properties: z.array(z.object({ name: z.string(), value: z.union([z.string(), z.number(), z.boolean()]).transform(String) })).optional() })).min(1).max(250) });
export type ShopifyOrder = z.input<typeof orderSchema>;
export type ShopifyLine = NonNullable<ShopifyOrder['line_items']>[number];
export function verifyShopifyHmac(raw: Buffer, header: string | undefined, secret: string) { if (!header || !secret) return false; const a = Buffer.from(createHmac('sha256', secret).update(raw).digest('base64')), b = Buffer.from(header); return a.length === b.length && timingSafeEqual(a, b); }
const idString = (v: unknown) => v == null ? undefined : String(v);
export async function upsertOrder(tx: Tx, input: ShopifyOrder, shopDomain?: string) {
  const p = orderSchema.parse(input); ensure(new Set(p.line_items.map(l => String(l.id))).size === p.line_items.length, 'Duplicate order lines', 400);
  const externalId = String(p.id), old = await tx.salesOrder.findUnique({ where: { source_externalId: { source: 'SHOPIFY', externalId } }, include: { lines: true } });
  ensure(!old?.shopDomain || old.shopDomain === shopDomain, 'Order belongs to a different shop');
  const lines = p.line_items.map(l => ({ externalLineId: String(l.id), title: l.name ?? l.title ?? 'Shopify item', sku: l.sku || undefined, shopifyProductId: idString(l.product_id), shopifyVariantId: idString(l.variant_id), quantity: l.quantity, properties: Object.fromEntries((l.properties ?? []).map(x => [x.name, x.value])) }));
  const data = { orderNumber: p.name ?? String(p.order_number ?? p.id), shopDomain, financialStatus: p.financial_status ?? undefined, fulfillmentStatus: p.fulfillment_status ?? undefined, currency: p.currency, total: p.total_price ? new Prisma.Decimal(p.total_price) : undefined, customerName: [p.customer?.first_name, p.customer?.last_name].filter(Boolean).join(' ') || undefined, customerEmail: p.email ?? p.customer?.email ?? undefined, raw: json(p) };
  if (!old) return tx.salesOrder.create({ data: { source: 'SHOPIFY', externalId, ...data, externalCreatedAt: p.created_at ? new Date(p.created_at) : undefined, lines: { create: lines } }, include: { lines: true } });
  const signature = (l: any) => JSON.stringify([l.externalLineId, l.quantity, l.sku ?? '', l.shopifyProductId ?? '', l.shopifyVariantId ?? '', Object.entries(l.properties ?? {}).sort()]);
  const changed = old.lines.map(signature).sort().join('|') !== lines.map(signature).sort().join('|');
  if (changed && old.lines.some(l => l.buildIds.length)) {
    await tx.salesOrderLine.updateMany({ where: { salesOrderId: old.id }, data: { status: 'BLOCKED', resolutionMessage: 'Shopify order changed after builds were created. Reconcile the existing builds before continuing.' } });
    return tx.salesOrder.update({ where: { id: old.id }, data: { ...data, status: 'BLOCKED' }, include: { lines: true } });
  }
  if (changed) { await tx.salesOrderLine.deleteMany({ where: { salesOrderId: old.id } }); await tx.salesOrderLine.createMany({ data: lines.map(l => ({ ...l, salesOrderId: old.id })) }); }
  return tx.salesOrder.update({ where: { id: old.id }, data, include: { lines: true } });
}
export async function findMapping(tx: Tx | PrismaClient, line: { shopifyVariantId?: string | null; shopifyProductId?: string | null; sku?: string | null }, shopDomain?: string | null) {
  const ors: Prisma.ShopifyProductMappingWhereInput[] = [];
  if (line.shopifyVariantId) ors.push({ shopifyVariantId: line.shopifyVariantId });
  if (line.shopifyProductId) ors.push({ shopifyProductId: line.shopifyProductId, shopifyVariantId: null });
  if (line.sku) ors.push({ sku: line.sku, shopifyVariantId: null, shopifyProductId: null });
  if (!ors.length) return null;
  const matches = await tx.shopifyProductMapping.findMany({ where: { active: true, product: { active: true }, OR: ors, AND: [{ OR: [{ shopDomain: shopDomain ?? null }, { shopDomain: null }] }] }, include: { product: true, configurationRules: true }, orderBy: [{ priority: 'asc' }, { id: 'asc' }] });
  const rank = (m: typeof matches[number]) => (m.shopifyVariantId ? 0 : m.shopifyProductId ? 10000 : 20000) + (m.shopDomain ? 0 : 1000) + m.priority;
  return matches.sort((a, b) => rank(a) - rank(b))[0] ?? null;
}
export function configurationOverrides(mapping: any, line: any) {
  const overrides = new Map<string, { skuId: string; quantity?: number }>();
  for (const rule of mapping?.configurationRules ?? []) {
    const value = rule.propertyName === '__variant_id__' ? line.shopifyVariantId : rule.propertyName === '__sku__' ? line.sku : (line.properties ?? {})[rule.propertyName];
    if (String(value ?? '') === rule.propertyValue) {
      const prior = overrides.get(rule.role); ensure(!prior || prior.skuId === rule.replacementSkuId, `Conflicting configuration rules for ${rule.role}`);
      overrides.set(rule.role, { skuId: rule.replacementSkuId, quantity: rule.quantity ?? undefined });
    }
  }
  // If a configured option is supplied with an unknown value, do not silently build the default.
  for (const name of new Set<string>((mapping?.configurationRules ?? []).map((r: any) => r.propertyName))) {
    if (name.startsWith('__') || !(name in (line.properties ?? {}))) continue;
    ensure(mapping.configurationRules.some((r: any) => r.propertyName === name && r.propertyValue === String(line.properties[name])), `Unmapped configuration: ${name} = ${line.properties[name]}`);
  }
  return overrides;
}
export async function resolveOrder(tx: Tx, id: string, locationId?: string) {
  const order = await tx.salesOrder.findUniqueOrThrow({ where: { id }, include: { lines: true } });
  ensure(order.status !== 'CANCELLED', 'Cancelled orders cannot be resolved');
  ensure(order.financialStatus === 'paid', 'Payment must be confirmed before production');
  for (const line of order.lines) {
    if (line.buildIds.length) {
      if (line.resolutionMessage?.startsWith('Shopify order changed')) continue;
    } else {
      const mapping = await findMapping(tx, line, order.shopDomain);
      const productId = line.resolvedProductId ?? mapping?.productId;
      const bom = productId ? await tx.bomVersion.findFirst({ where: { productId, active: true }, orderBy: { version: 'desc' } }) : null;
      if (!productId || !bom) { await tx.salesOrderLine.update({ where: { id: line.id }, data: { status: 'BLOCKED', resolutionMessage: productId ? 'Product has no active BOM' : 'No product mapping; choose a product for this order line' } }); continue; }
      let overrides: ReturnType<typeof configurationOverrides>;
      try { overrides = configurationOverrides(mapping, line); } catch (e) { await tx.salesOrderLine.update({ where: { id: line.id }, data: { status: 'BLOCKED', resolutionMessage: (e as Error).message } }); continue; }
      const buildIds: string[] = [];
      for (let i = 0; i < line.quantity; i++) { const build = await createBuild(tx, { buildNumber: `${order.orderNumber.replace(/[^A-Za-z0-9-]/g, '')}-${line.id.slice(-8)}-${i + 1}`, productId, bomVersionId: bom.id, externalOrderId: order.externalId }, overrides); buildIds.push(build.id); }
      await tx.salesOrderLine.update({ where: { id: line.id }, data: { buildIds, resolvedProductId: productId, mappingId: mapping?.id, status: 'RESOLVED', resolutionMessage: null } }); line.buildIds = buildIds;
    }
    if (locationId) for (const buildId of line.buildIds) {
      const build = await tx.build.findUniqueOrThrow({ where: { id: buildId }, include: { lines: true } });
      if (build.status !== 'CREATED') continue;
      const demand = new Map<string, number>(); for (const l of build.lines) if (l.allocatedSkuId) demand.set(l.allocatedSkuId, (demand.get(l.allocatedSkuId) ?? 0) + l.quantity);
      let enough = build.lines.every(l => l.allocatedSkuId);
      for (const [skuId, qty] of demand) if ((await position(tx, skuId, locationId)).available < qty) enough = false;
      if (enough) await reserveBuild(tx, buildId, locationId);
    }
  }
  await syncOrderStatuses(tx); return tx.salesOrder.findUniqueOrThrow({ where: { id }, include: { lines: true } });
}
// Retained CLI interfaces also participate in the shared write lock.
export const upsertShopifyOrder = (db: PrismaClient, payload: ShopifyOrder, shopDomain?: string) => transaction(db, tx => upsertOrder(tx, payload, shopDomain));
export const resolveSalesOrder = (db: PrismaClient, id: string, locationId?: string) => transaction(db, tx => resolveOrder(tx, id, locationId));
