import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { ensure, json, transaction, type Tx } from './core.js';
import { readConnection, saveConnection } from './connections.js';
import { D, money } from './fx.js';
import { AkahuError, akahuRequest, bankingGate, page } from './akahu-client.js';

export async function bankFeed(tx: PrismaClient | Tx) {
  return tx.bankFeed.upsert({ where: { id: 'akahu' }, create: { id: 'akahu', since: new Date(new Date().toISOString().slice(0, 10)) }, update: {} });
}
export function bankIdle(f: any) { ensure(!f.leaseUntil || f.leaseUntil < new Date(), 'A bank operation is running. Retry when it finishes.', 409); }
export async function bankLease<T>(db: PrismaClient, fn: (config: any, owner: string) => Promise<T>): Promise<T> {
  const owner = randomUUID();
  const config = await transaction(db, async tx => {
    const f = await bankFeed(tx); bankingGate(f.mode); bankIdle(f);
    ensure(!f.nextRequestAt || f.nextRequestAt <= new Date(), 'Akahu requests are paused until ' + f.nextRequestAt?.toISOString(), 409);
    const c = await readConnection(tx, 'AKAHU'); ensure(c?.accessToken && f.status === 'CONNECTED', 'Connect the Akahu full app first.', 409);
    await tx.bankFeed.update({ where: { id: f.id }, data: { leaseOwner: owner, leaseUntil: new Date(Date.now() + 45000) } }); return c;
  });
  try { return await fn(config, owner); }
  catch (e) {
    await transaction(db, async tx => {
      const f = await bankFeed(tx); if (f.leaseOwner !== owner) return;
      if (e instanceof AkahuError && e.providerStatus === 401) {
        const c = await readConnection(tx, 'AKAHU'); delete c.accessToken;
        await saveConnection(tx, 'AKAHU', c, { configured: true });
      }
      await tx.bankFeed.update({ where: { id: f.id }, data: {
        status: e instanceof AkahuError && e.providerStatus === 401 ? 'REAUTHORIZE' : f.status,
        error: e instanceof AkahuError ? e.message : 'Bank operation failed. Review saved progress and retry.',
        nextRequestAt: e instanceof AkahuError && e.retryAt ? e.retryAt : new Date(Date.now() + 60000),
      } });
    }); throw e;
  } finally {
    await db.bankFeed.updateMany({ where: { id: 'akahu', leaseOwner: owner }, data: { leaseOwner: null, leaseUntil: null } });
  }
}
export async function assertLease(tx: Tx, owner: string) {
  const f = await bankFeed(tx); ensure(f.leaseOwner === owner, 'Bank operation lease changed; retry safely.', 409);
  await tx.bankFeed.update({ where: { id: f.id }, data: { leaseUntil: new Date(Date.now() + 45000) } });
}
export async function loadBankAccounts(db: PrismaClient) {
  return bankLease(db, async (c, owner) => {
    const accounts: any[] = []; let cursor: string | null = null; const seen = new Set<string>();
    do {
      const p = page(await akahuRequest(c, '/accounts' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : '')));
      accounts.push(...p.items); cursor = p.next;
      ensure(!cursor || !seen.has(cursor), 'Akahu repeated an account cursor. Retry account discovery.', 502); if (cursor) seen.add(cursor);
      await transaction(db, tx => assertLease(tx, owner));
    } while (cursor);
    await transaction(db, async tx => {
      await assertLease(tx, owner);
      await tx.bankAccount.updateMany({ data: { status: 'UNAVAILABLE', eligible: false } });
      for (const a of accounts) {
        if (!/^(BNZ|Bank of New Zealand)$/i.test(a.connection?.name ?? '')) continue;
        ensure(/^acc_[\w-]+$/.test(a._id), 'Invalid Akahu account identifier', 502);
        const currency = /^[A-Z]{3}$/.test(a.balance?.currency ?? '') ? a.balance.currency : 'XXX';
        const data = { name: String(a.name ?? 'BNZ account'), institution: a.connection.name, currency,
          maskedNumber: a.formatted_account ? '…' + String(a.formatted_account).slice(-4) : null,
          status: String(a.status), eligible: a.status === 'ACTIVE' && a.attributes?.includes('TRANSACTIONS') && currency !== 'XXX',
          authorisationId: a._authorisation ?? a._credentials ?? null, predecessorId: a._migrated ?? null, refreshedAt: a.refreshed?.transactions ? new Date(a.refreshed.transactions) : null };
        if(a._migrated && await tx.bankTransaction.count({where:{accountId:a._migrated,status:'POSTED'}})) data.eligible=false;
        await tx.bankAccount.upsert({ where: { id: a._id }, create: { id: a._id, ...data }, update: data });
      }
      await tx.bankAccount.updateMany({ where: { eligible: false }, data: { selected: false } });
      await tx.bankFeed.update({ where: { id: 'akahu' }, data: { error: null } });
    }); return { loaded: true };
  });
}
function fields(t: any, account: any) {
  ensure(t._account === account.id && Number.isFinite(t.amount) && Number.isFinite(Date.parse(t.date)), 'Invalid bank transaction; page was not imported.', 502);
  const references = Object.fromEntries(['particulars', 'code', 'reference', 'other_account', 'conversion'].filter(k => t.meta?.[k] != null).map(k => [k, t.meta[k]]));
  if (t.merchant?.name) references.merchant = t.merchant.name;
  return { accountId: account.id, currency: account.currency, amount: money(t.amount), date: new Date(t.date), description: String(t.description ?? ''), references: json(references), providerUpdatedAt: t.updated_at ? new Date(t.updated_at) : null };
}
export async function startBankSync(db: PrismaClient) {
  if(!(await db.bankSync.count({where:{status:{in:['RUNNING','FAILED']}}}))) await loadBankAccounts(db);
  return transaction(db, async tx => {
    const f = await bankFeed(tx); bankingGate(f.mode); ensure(f.status === 'CONNECTED', 'Connect Akahu first', 409);
    const old = await tx.bankSync.findFirst({ where: { status: { in: ['RUNNING', 'FAILED'] } }, orderBy: { startedAt: 'desc' } });
    if (old) return old;
    const accounts = await tx.bankAccount.findMany({ where: { selected: true, eligible: true } }); ensure(accounts.length, 'Select eligible BNZ accounts first.', 400);
    // Reconcile the full selected history, so provider deletions and ID replacements are detected.
    return tx.bankSync.create({ data: { accountIds: accounts.map(a => a.id), start: new Date(f.since.getTime() - 1), end: new Date() } });
  });
}
export async function runBankSync(db: PrismaClient, maxPages = 3) {
  return bankLease(db, async (c, owner) => {
    for (let attempt = 0; attempt < maxPages; attempt++) {
      const job = await db.bankSync.findFirst({ where: { status: { in: ['RUNNING', 'FAILED'] } }, orderBy: { startedAt: 'desc' } });
      if (!job) return { complete: true };
      const ids = job.accountIds as string[], account = await db.bankAccount.findUniqueOrThrow({ where: { id: ids[job.accountIndex] } });
      ensure(account.selected && account.eligible, 'Account selection changed. Cancel this import and start a new one.', 409);
      const query = new URLSearchParams({ start: job.start.toISOString(), end: job.end.toISOString() }); if (job.cursor) query.set('cursor', job.cursor);
      try {
        const p = page(await akahuRequest(c, '/accounts/' + account.id + '/transactions?' + query));
        ensure(!p.next || p.next !== job.cursor, 'Akahu repeated a transaction cursor. Retry this import.', 502);
        const pending = p.next ? null : page(await akahuRequest(c, '/accounts/' + account.id + '/transactions/pending'));
        ensure(!pending?.next, 'Unexpected paginated pending response; no data was replaced.', 502);
        await transaction(db, async tx => {
          await assertLease(tx, owner);
          const current = await tx.bankSync.findUniqueOrThrow({ where: { id: job.id } }); ensure(current.cursor === job.cursor && current.accountIndex === job.accountIndex, 'Import progress changed', 409);
          for (const t of p.items) {
            ensure(/^trans_[\w-]+$/.test(t._id), 'Missing posted transaction ID', 502); const data = fields(t, account);
            const old = await tx.bankTransaction.findUnique({ where: { id: t._id }, include: { allocations: { where: { reversedAt: null } } } });
            ensure(!old || old.accountId === account.id, 'Provider transaction changed accounts. Review required.', 502);
            const changed = old && (!old.amount.eq(data.amount) || old.currency !== data.currency || old.date.getTime() !== data.date.getTime() || old.description !== data.description || !isDeepStrictEqual(old.references, data.references));
            await tx.bankTransaction.upsert({ where: { id: t._id }, create: { id: t._id, ...data, seenSync: job.id }, update: { ...data, status: 'POSTED', seenSync: job.id, ...(changed ? { revision: { increment: 1 }, reviewRequired: old!.allocations.length > 0 || old!.reviewRequired } : {}) } });
          }
          if (pending) {
            await tx.bankAccount.update({ where: { id: account.id }, data: { pending: json(pending.items.map((t: any) => ({ ...fields(t, account), status: 'PENDING' }))), pendingAt: new Date() } });
            const removed = await tx.bankTransaction.findMany({ where: { accountId: account.id, date: { gt: job.start, lte: job.end }, OR: [{ seenSync: null }, { seenSync: { not: job.id } }], status: 'POSTED' }, include: { allocations: { where: { reversedAt: null } } } });
            for (const row of removed) await tx.bankTransaction.update({ where: { id: row.id }, data: { status: 'REMOVED', revision: { increment: 1 }, reviewRequired: row.allocations.length > 0 } });
          }
          const complete = !p.next && job.accountIndex + 1 === ids.length;
          await tx.bankSync.update({ where: { id: job.id }, data: { status: complete ? 'COMPLETE' : 'RUNNING', cursor: p.next, accountIndex: p.next ? job.accountIndex : job.accountIndex + 1, pages: { increment: 1 }, imported: { increment: p.items.length }, error: null, ...(complete ? { completedAt: new Date() } : {}) } });
          await tx.bankFeed.update({ where: { id: 'akahu' }, data: { error: null, nextRequestAt: null, ...(complete ? { lastSyncAt: new Date() } : {}) } });
        });
      } catch (e) { await transaction(db, async tx => { if ((await bankFeed(tx)).leaseOwner === owner) await tx.bankSync.update({ where: { id: job.id }, data: { status: 'FAILED', error: 'Import paused. Completed pages are saved; retry resumes this page.' } }); }); throw e; }
    }
    return { complete: !(await db.bankSync.count({ where: { status: { in: ['RUNNING', 'FAILED'] } } })) };
  });
}
export async function requestBankRefresh(db: PrismaClient) {
  return bankLease(db, async (c, owner) => {
    const f = await bankFeed(db), rest = Math.max(15, Number(process.env.AKAHU_REFRESH_REST_MINUTES) || 15) * 60000;
    ensure(!f.lastRefreshAttempt || Date.now() - f.lastRefreshAttempt.getTime() >= rest, 'Manual bank refresh is cooling down. Fetch cached transactions instead.', 409);
    const accounts = await db.bankAccount.findMany({ where: { selected: true, eligible: true } }); ensure(accounts.length, 'Select BNZ accounts first', 400);
    await transaction(db, async tx => { await assertLease(tx, owner); await tx.bankFeed.update({ where: { id: f.id }, data: { lastRefreshAttempt: new Date() } }); });
    // BNZ accounts may share bank credentials; one request can refresh all associated accounts.
    const groups = new Map(accounts.map(a => [a.authorisationId ?? a.id, a]));
    for (const a of groups.values()) {
      if (a.refreshedAt && Date.now() - a.refreshedAt.getTime() < rest) continue;
      await akahuRequest(c, '/refresh/' + a.id, 'POST');
      await transaction(db, tx => assertLease(tx, owner));
    }
    return { requested: true, message: 'Refresh requested, not completed. Akahu may defer it under its rest-period rules. Fetch cached data later and inspect account refreshed times.' };
  });
}
