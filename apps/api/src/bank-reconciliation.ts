import { PrismaClient } from '@prisma/client';
import { actor, ensure, json, mutate, type Tx } from './core.js';
import { D, money } from './fx.js';
import { bankingGate } from './akahu-client.js';
import { bankFeed } from './banking-sync.js';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';

const sum = (rows: any[], key: string) => rows.reduce((n, r) => n.add(r[key]), D(0));
const tokens = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
export function matchEvidence(payment: any, invoice: any) {
  const text = tokens(payment.description + ' ' + JSON.stringify(payment.references)), evidence: string[] = []; let score = 0;
  const number = tokens(invoice.invoiceNumber ?? '');
  if (number.length >= 3 && (' ' + text + ' ').includes(' ' + number + ' ')) { score += 60; evidence.push('Invoice number appears in bank description/references'); }
  const identity = tokens(invoice.supplier?.name ?? '').split(' ').filter((s: string) => s.length >= 3 && !['LIMITED', 'LTD', 'NEW', 'ZEALAND', 'STORE'].includes(s));
  if (identity.length && identity.some((s: string) => (' ' + text + ' ').includes(' ' + s + ' '))) { score += 25; evidence.push('Supplier name overlaps bank merchant/description'); }
  if (invoice.currency === payment.currency) { score += 5; evidence.push('Same currency: ' + invoice.currency); }
  else evidence.push('Foreign invoice: original ' + invoice.currency + '; actual debit ' + payment.currency);
  const paid = sum(invoice.bankAllocations ?? [], 'originalAmount');
  const remaining = invoice.total == null ? null : D(invoice.total).sub(paid);
  const converted = remaining && (invoice.currency === 'NZD' ? remaining : invoice.fxLockedAt && invoice.fxRate ? money(remaining.mul(invoice.fxRate)) : null);
  if (converted && converted.sub(D(payment.amount).abs()).abs().lte('.01')) { score += 20; evidence.push('Debit equals remaining invoice value at the approved rate'); }
  const conversion = payment.references?.conversion;
  if (remaining && conversion?.currency === invoice.currency && Number.isFinite(conversion.amount) && remaining.sub(D(conversion.amount).abs()).abs().lte('.01')) { score += 20; evidence.push('Bank foreign-currency detail equals remaining original amount'); }
  if (invoice.invoiceDate) {
    const days = (new Date(payment.date).getTime() - new Date(invoice.invoiceDate).getTime()) / 86400000;
    if (days >= -7 && days <= 90) { score += 5; evidence.push('Payment date is within -7 to +90 days of invoice date'); }
    else evidence.push('Payment date is outside the normal matching window');
  }
  if (!invoice.fxLockedAt && invoice.currency !== 'NZD') evidence.push('Invoice rate is not approved; exchange difference cannot yet be established');
  if (invoice.payments?.some((p: any) => !p.bankAllocationId && !p.reversedAt)) evidence.push('Existing manually recorded payment needs review to avoid duplication');
  return { invoiceId: invoice.id, version: invoice.version, invoiceNumber: invoice.invoiceNumber, supplier: invoice.supplier?.name,
    currency: invoice.currency, total: invoice.total, remainingOriginal: remaining?.toFixed(2) ?? null, expectedNzd: converted?.toFixed(2) ?? null, score, evidence };
}
export async function bankSuggestions(db: PrismaClient, id: string) {
  const payment = await db.bankTransaction.findUniqueOrThrow({ where: { id } });
  if (payment.status !== 'POSTED' || payment.reviewRequired || payment.amount.gte(0)) return { suggestions: [], ambiguous: false };
  const invoices = await db.supplierInvoice.findMany({ where: { status: { in: ['REVIEW', 'APPROVED'] } }, include: { supplier: true, bankAllocations: { where: { reversedAt: null } }, payments: true } });
  const suggestions = invoices.map(i => matchEvidence(payment, i)).filter(i => i.score >= 20 && (i.remainingOriginal == null || D(i.remainingOriginal).gt(0))).sort((a, b) => b.score - a.score).slice(0, 30);
  return { suggestions, ambiguous: suggestions.length > 1 && suggestions[0].score - suggestions[1].score <= 10 };
}
const amount = z.string().regex(/^\d{1,12}(\.\d{1,2})?$/);
export async function registerReconciliation(app: FastifyInstance, db: PrismaClient) {
  app.get('/banking/transactions/:id/suggestions', q => bankSuggestions(db, (q.params as any).id));
  app.post('/banking/transactions/:id/allocate', async q => {
    const b = z.object({ revision: z.number().int(), confirmed: z.literal(true), note: z.string().trim().min(3).max(1000),
      lines: z.array(z.object({ invoiceId: z.string(), invoiceVersion: z.number().int(), originalAmount: amount, amountNzd: amount, feeNzd: amount })).min(1).max(50) }).parse(q.body);
    return mutate(db, q, 'Confirm bank invoice allocations (no invoice approval or stock movement)', async tx => {
      bankingGate((await bankFeed(tx)).mode);
      const payment = await tx.bankTransaction.findUniqueOrThrow({ where: { id: (q.params as any).id }, include: { allocations: { where: { reversedAt: null } }, account: true } });
      ensure(payment.status === 'POSTED' && !payment.reviewRequired && payment.revision === b.revision, 'Bank transaction changed, was removed, or needs review. Reload before matching.', 409);
      ensure(payment.currency === 'NZD' && payment.amount.lt(0), 'Only posted outgoing NZD bank payments can record actual NZD invoice payments.', 400);
      ensure((await tx.bankSync.findFirst({orderBy:{startedAt:'desc'}}))?.status==='COMPLETE', 'Complete a full bank import before reconciling. A cancelled or failed scan is not a verified bank snapshot.', 409);
      ensure(!(await tx.bankTransaction.count({ where: { accountId: payment.accountId, reviewRequired: true } })), 'This account has changed/removed reconciled transactions. Reverse and review those allocations before adding another match.', 409);
      ensure(new Set(b.lines.map(l => l.invoiceId)).size === b.lines.length, 'Use only one row per invoice in this allocation.', 400);
      const used = sum(payment.allocations, 'amountNzd').add(sum(payment.allocations, 'feeNzd'));
      const proposed = sum(b.lines, 'amountNzd').add(sum(b.lines, 'feeNzd'));
      ensure(proposed.gt(0) && used.add(proposed).lte(payment.amount.abs()), 'Allocations plus fees exceed the unallocated bank debit.', 409);
      const ids: string[] = [];
      for (const line of b.lines) {
        ensure((D(line.originalAmount).gt(0) && D(line.amountNzd).gt(0)) || (D(line.originalAmount).eq(0) && D(line.amountNzd).eq(0) && D(line.feeNzd).gt(0)), 'Enter positive principal amounts, or zero principal with a positive separately charged fee.', 400);
        const invoice = await tx.supplierInvoice.findUniqueOrThrow({ where: { id: line.invoiceId }, include: { supplier: true, bankAllocations: { where: { reversedAt: null } }, payments: true } });
        ensure(invoice.version === line.invoiceVersion && ['REVIEW', 'APPROVED'].includes(invoice.status), 'Invoice changed or cannot receive a payment allocation. Reload it.', 409);
        ensure(invoice.total != null && invoice.currency !== 'XXX', 'Enter a verified original invoice total and currency before reconciliation.', 400);
        const manual = invoice.payments.filter(p => !p.bankAllocationId && !p.reversedAt);
        ensure(!manual.length, 'This invoice already has manually recorded payments. Review and reverse duplicate manual records before allocating a bank transaction.', 409);
        const priorOriginal = sum(invoice.bankAllocations, 'originalAmount');
        ensure(priorOriginal.add(line.originalAmount).lte(invoice.total!), 'Allocation exceeds the remaining original invoice amount.', 409);
        if (invoice.currency === 'NZD') ensure(D(line.originalAmount).eq(line.amountNzd), 'NZD invoice principal must equal the NZD payment principal; enter fees separately.', 400);
        const approvedRate = invoice.currency === 'NZD' ? D(1) : invoice.fxLockedAt && invoice.fxRate ? invoice.fxRate : null;
        // Cumulative rounding makes partial payment exchange differences reconcile to the full approved invoice.
        const expected = approvedRate ? D(line.originalAmount).eq(0) ? D(0) : money(priorOriginal.add(line.originalAmount).mul(approvedRate)).sub(invoice.bankAllocations.every(a=>a.expectedNzd!=null)?sum(invoice.bankAllocations, 'expectedNzd'):money(priorOriginal.mul(approvedRate))) : null;
        const allocation = await tx.bankAllocation.create({ data: {
          transactionId: payment.id, invoiceId: invoice.id, invoiceCurrency: invoice.currency, originalAmount: D(line.originalAmount), amountNzd: D(line.amountNzd), feeNzd: D(line.feeNzd),
          approvedRate, expectedNzd: expected, exchangeDifferenceNzd: expected ? money(D(line.amountNzd).sub(expected)) : null,
          evidence: json({ note: b.note, suggestion: matchEvidence(payment, invoice), transactionRevision: payment.revision, originalInvoiceTotal: invoice.total }), confirmedBy: actor(q),
        } });
        await tx.invoicePayment.create({ data: { bankAllocationId: allocation.id, invoiceId: invoice.id, amountNzd: D(line.amountNzd), paidAt: new Date(new Intl.DateTimeFormat('en-CA', {timeZone:'Pacific/Auckland',year:'numeric',month:'2-digit',day:'2-digit'}).format(payment.date)), reference: 'Akahu ' + payment.id, recordedBy: actor(q) } });
        ids.push(allocation.id);
      }
      return { allocationIds: ids };
    });
  });
  app.post('/banking/allocations/:id/reverse', async q => {
    const { reason } = z.object({ reason: z.string().trim().min(5).max(1000) }).parse(q.body);
    return mutate(db, q, 'Reverse bank payment allocation', async tx => {
      const a = await tx.bankAllocation.findUniqueOrThrow({ where: { id: (q.params as any).id } }); ensure(!a.reversedAt, 'Allocation already reversed.', 409);
      const now = new Date();
      await tx.bankAllocation.update({ where: { id: a.id }, data: { reversedAt: now, reversedBy: actor(q), reversalReason: reason } });
      await tx.invoicePayment.update({ where: { bankAllocationId: a.id }, data: { reversedAt: now, reversalReason: reason } });
      if (!(await tx.bankAllocation.count({ where: { transactionId: a.transactionId, reversedAt: null } }))) await tx.bankTransaction.update({ where: { id: a.transactionId }, data: { reviewRequired: false } });
      return { reversed: true };
    });
  });
  app.post('/banking/manual-payments/:id/reverse', async q => {
    const { reason } = z.object({ reason: z.string().trim().min(5).max(1000) }).parse(q.body);
    return mutate(db, q, 'Reverse manually recorded payment for reconciliation review', async tx => {
      const p = await tx.invoicePayment.findUniqueOrThrow({ where: { id: (q.params as any).id } }); ensure(!p.bankAllocationId && !p.reversedAt, 'Use the bank allocation reversal for bank-linked payments.', 409);
      await tx.invoicePayment.update({ where: { id: p.id }, data: { reversedAt: new Date(), reversalReason: reason } }); return { reversed: true };
    });
  });
}
