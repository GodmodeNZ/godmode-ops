import { createHash } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import type { FastifyRequest } from 'fastify';

export class DomainError extends Error {
  constructor(message: string, public statusCode = 409) { super(message); }
}
export type Tx = Prisma.TransactionClient;
export function ensure(condition: unknown, message: string, code = 409): asserts condition {
  if (!condition) throw new DomainError(message, code);
}
export const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value));
export const actor = (q: FastifyRequest) => (q as any).user?.email ?? 'controller';

// All operational writes take the same transaction-level lock. A small factory values
// correctness over parallel write throughput. ReadCommitted takes a fresh snapshot after
// waiting for this lock, preventing overselling and double-receiving across API processes.
export async function transaction<T>(db: PrismaClient, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(741392610)`;
    return fn(tx);
  }, { isolationLevel: 'ReadCommitted', maxWait: 15000, timeout: 30000 });
}
export async function mutate<T>(db: PrismaClient, q: FastifyRequest, action: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const key = q.headers['idempotency-key'];
  ensure(typeof key === 'string' && key.length >= 8 && key.length <= 128, 'An Idempotency-Key header is required', 400);
  const fingerprint = createHash('sha256').update(JSON.stringify([actor(q), q.method, q.url, q.body])).digest('hex');
  return transaction(db, async tx => {
    const old = await tx.operation.findUnique({ where: { key } });
    if (old) { ensure(old.fingerprint === fingerprint, 'This request key was already used for different data'); return old.result as T; }
    const result = await fn(tx);
    await tx.auditLog.create({ data: { actor: actor(q), action, reference: q.url } });
    await tx.operation.create({ data: { key, fingerprint, result: json(result) } });
    return result;
  });
}
export async function position(tx: Tx, skuId: string, locationId?: string) {
  const [stock, reservations] = await Promise.all([
    tx.inventoryTransaction.aggregate({ where: { skuId, locationId }, _sum: { quantityDelta: true } }),
    tx.inventoryReservation.aggregate({ where: { skuId, locationId, status: 'ACTIVE' }, _sum: { quantity: true } }),
  ]);
  const onHand = stock._sum.quantityDelta ?? 0, reserved = reservations._sum.quantity ?? 0;
  return { onHand, reserved, available: onHand - reserved };
}
export async function averageCost(tx: Tx, skuId: string, locationId?: string) {
  // Moving weighted-average receipts, preserving the cost on every outgoing movement.
  const entries = await tx.inventoryTransaction.findMany({ where: { skuId, locationId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  let qty = 0, value = new Prisma.Decimal(0);
  for (const e of entries) {
    const cost = e.unitCost ?? (qty > 0 ? value.div(qty) : new Prisma.Decimal(0));
    value = value.add(cost.mul(e.quantityDelta)); qty += e.quantityDelta;
    if (qty <= 0) value = new Prisma.Decimal(0);
  }
  return qty > 0 ? value.div(qty).toDecimalPlaces(2) : new Prisma.Decimal(0);
}
export async function syncOrderStatuses(tx: Tx) {
  const orders = await tx.salesOrder.findMany({ where: { status: { not: 'CANCELLED' } }, include: { lines: true } });
  for (const o of orders) {
    const ids = o.lines.flatMap(l => l.buildIds);
    const builds = await tx.build.findMany({ where: { id: { in: ids } }, include: { unit: { include: { shipment: true } } } });
    const status = o.lines.some(l => l.status !== 'RESOLVED') || !builds.length || builds.some(b => ['CREATED', 'CANCELLED'].includes(b.status)) ? 'BLOCKED'
      : builds.every(b => b.unit?.shipment) ? 'COMPLETED'
      : builds.some(b => ['IN_PROGRESS', 'COMPLETED'].includes(b.status)) ? 'IN_PRODUCTION' : 'READY_FOR_PRODUCTION';
    if (o.status !== status) await tx.salesOrder.update({ where: { id: o.id }, data: { status } });
  }
}
