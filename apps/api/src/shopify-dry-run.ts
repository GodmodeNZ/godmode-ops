import type { PrismaClient } from '@prisma/client';
import { findMapping, configurationOverrides, orderSchema, type ShopifyOrder } from './shopify.js';
export async function dryRunShopifyOrder(db: PrismaClient, input: ShopifyOrder, shopDomain?: string, locationId?: string) {
  const order = orderSchema.parse(input), demand = new Map<string, number>(), lines: any[] = []; let buildCount = 0;
  for (const source of order.line_items) {
    const line = { shopifyVariantId: source.variant_id == null ? null : String(source.variant_id), shopifyProductId: source.product_id == null ? null : String(source.product_id), sku: source.sku, properties: Object.fromEntries((source.properties ?? []).map(p => [p.name, p.value])) };
    const mapping = await findMapping(db, line, shopDomain), components: any[] = [], messages: string[] = [];
    const bom = mapping ? await db.bomVersion.findFirst({ where: { productId: mapping.productId, active: true }, orderBy: { version: 'desc' }, include: { lines: { include: { exactSku: true, approvedSkus: { include: { sku: true }, orderBy: { priority: 'asc' } } } } } }) : null;
    if (!mapping) messages.push('No product mapping'); else if (!bom) messages.push('No active BOM');
    if (bom) {
      try {
        const overrides = configurationOverrides(mapping, line);
        for (const bl of bom.lines) {
          const o = overrides.get(bl.role), skuId = o?.skuId ?? bl.exactSkuId ?? bl.approvedSkus[0]?.skuId;
          if (!skuId) { messages.push(`No approved SKU for ${bl.role}`); continue; }
          const sku = await db.sku.findUniqueOrThrow({ where: { id: skuId } }); const required = (o?.quantity ?? bl.quantity) * source.quantity;
          const stock = await db.inventoryTransaction.aggregate({ where: { skuId, locationId }, _sum: { quantityDelta: true } });
          const reservations = await db.inventoryReservation.aggregate({ where: { skuId, locationId, status: 'ACTIVE' }, _sum: { quantity: true } });
          const available = (stock._sum.quantityDelta ?? 0) - (reservations._sum.quantity ?? 0) - (demand.get(skuId) ?? 0);
          demand.set(skuId, (demand.get(skuId) ?? 0) + required);
          if (!sku.active || available < required) messages.push(`Insufficient ${sku.name}`);
          components.push({ role: bl.role, skuId, skuCode: sku.code, skuName: sku.name, required, available });
        }
      } catch (e) { messages.push((e as Error).message); }
      buildCount += source.quantity;
    }
    if (order.financial_status !== 'paid') messages.push('Payment is not confirmed');
    lines.push({ title: source.title, sku: source.sku, quantity: source.quantity, productName: mapping?.product.name, bomVersion: bom?.version, ok: !messages.length, message: messages.join('; '), components });
  }
  return { dryRun: true, orderNumber: order.name ?? String(order.id), status: lines.some(l => !l.ok) ? 'BLOCKED' : 'READY_FOR_PRODUCTION', buildCount, lines };
}
