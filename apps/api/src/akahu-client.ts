import { createHash } from 'node:crypto';
import { DomainError, ensure } from './core.js';

export const AKAHU_SCOPES = 'ENDURING_CONSENT ACCOUNTS TRANSACTIONS';
// Internal use is explicitly bound to the approved app and one account, never inferred from a database name.
export function internalUseGate(appId?: string) {
  ensure(process.env.AKAHU_INTERNAL_APPROVED === 'true' && process.env.AKAHU_PERSONAL_TEST !== 'true'
    && /^[a-f0-9]{64}$/.test(process.env.AKAHU_INTERNAL_APP_SHA256 ?? '')
    && /^acc_[\w-]+$/.test(process.env.AKAHU_INTERNAL_ACCOUNT_ID ?? ''), 'Internal use requires reviewed provider approval and an app/account allowlist configured by the server administrator.', 409);
  const origin = new URL(process.env.WEB_ORIGIN ?? 'http://localhost:4000');
  ensure(origin.protocol === 'https:' && process.env.COOKIE_SECURE !== 'false'
    || origin.protocol === 'http:' && ['localhost','127.0.0.1'].includes(origin.hostname), 'Internal bank access requires HTTPS with secure cookies, or a loopback-only local ERP.', 409);
  if (appId) ensure(createHash('sha256').update(appId).digest('hex') === process.env.AKAHU_INTERNAL_APP_SHA256, 'These credentials do not belong to the approved internal app.', 409);
}
export function internalAccountAllowed(id: string) { return id === process.env.AKAHU_INTERNAL_ACCOUNT_ID; }
export function bankSyncInterval(mode: string) { return mode === 'INTERNAL_PERSONAL' ? 86400000 : 900000; }
export function personalTestGate() {
  ensure(process.env.AKAHU_PERSONAL_TEST === 'true'
    && /^\/godmode_akahu_personal_test_\d+$/.test(new URL(process.env.DATABASE_URL!).pathname)
    && process.env.WEB_ORIGIN === 'http://127.0.0.1:4001'
    && process.env.API_HOST === '127.0.0.1'
    && process.env.NODE_ENV === 'test', 'Personal-app testing requires the dedicated isolated database, loopback test server and disabled workers.', 409);
}
export function personalTestWindow(since: string, until: string) {
  const start = new Date(since), end = new Date(until);
  ensure(Number.isFinite(start.getTime()) && Number.isFinite(end.getTime()) && end > start
    && end.getTime() - start.getTime() <= 7 * 86400000 && end <= new Date(), 'Choose a completed test window of at most seven days (end exclusive).', 400);
  return { start, end };
}
export class AkahuError extends DomainError {
  constructor(public providerStatus: number, public retryAt?: Date) {
    super(providerStatus === 401 ? 'Akahu access expired or was revoked. Reconnect your bank.'
      : providerStatus === 403 ? 'Akahu denied access. Check full-app permissions, eligible accounts and onboarding approval.'
      : providerStatus === 429 ? 'Akahu rate limit reached. Retry after the displayed wait time.'
      : 'Akahu could not complete the request. Saved progress is safe; retry the cached import.', 502);
  }
}
export function bankingGate(mode: string) {
  if (mode === 'INTERNAL_PERSONAL') { internalUseGate(); return; }
  if (mode === 'PERSONAL_TEST') { personalTestGate(); return; }
  ensure(process.env.AKAHU_PERSONAL_TEST !== 'true', 'This instance only supports isolated personal-app testing.', 409);
  const database = new URL(process.env.DATABASE_URL!).pathname;
  if (mode === 'PRODUCTION') {
    ensure(process.env.AKAHU_COMMERCIAL_APPROVED === 'true', 'Full-app commercial approval is required. Ask the server administrator to enable AKAHU_COMMERCIAL_APPROVED after Akahu approval.', 409);
    ensure(bankingCallback().startsWith('https:') && process.env.WEB_ORIGIN?.startsWith('https:') && process.env.COOKIE_SECURE !== 'false', 'Production banking requires an HTTPS ERP origin, HTTPS registered callback and secure session cookies.', 409);
  }
  else ensure(/^\/(godmode_fx_isolated_test_\d+|godmode_ops_ci_test)$/.test(database), 'Sandbox banking is restricted to an isolated test database. It cannot reconcile live business invoices.', 409);
}
export function bankingCallback() {
  const uri = process.env.AKAHU_REDIRECT_URI ?? (process.env.WEB_ORIGIN ?? 'http://localhost:4000').replace(/\/$/, '') + '/api/banking/callback';
  const url = new URL(uri);
  ensure(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)), 'Register an HTTPS callback, or an approved localhost development callback.', 400);
  ensure(!url.username && !url.password && !url.search && !url.hash && url.pathname === '/api/banking/callback', 'Callback must end in /api/banking/callback without a query or fragment.', 400);
  return uri;
}
export async function akahuRequest(config: any, path: string, method = 'GET', body?: any) {
  if (config?.kind === 'INTERNAL_PERSONAL') {
    internalUseGate(config.appId);
    ensure(method === 'GET', 'Internal personal apps allow cached reads only; bank refresh, OAuth and remote revocation are disabled.', 409);
    const accountId = /^\/accounts\/(acc_[\w-]+)\//.exec(path)?.[1];
    ensure(!accountId || internalAccountAllowed(accountId), 'Account is outside the approved internal allowlist.', 409);
  }
  if (config?.kind === 'PERSONAL_TEST' || process.env.AKAHU_PERSONAL_TEST === 'true') {
    personalTestGate();
    ensure(config?.kind === 'PERSONAL_TEST' && method === 'GET', 'Personal tests allow cached reads only. Refresh, OAuth and remote revocation are disabled.', 409);
  }
  // Fixed host and an explicit read/revoke/refresh allowlist prevent payment calls and credential forwarding.
  ensure((method === 'GET' && (/^\/accounts(?:\?cursor=[^#]*)?$/.test(path) || /^\/accounts\/acc_[\w-]+\/transactions(?:\/pending)?(?:\?[^#]*)?$/.test(path)))
    || (method === 'POST' && (path === '/token' || /^\/refresh\/acc_[\w-]+$/.test(path)))
    || (method === 'DELETE' && path === '/token'), 'Unsupported Akahu operation', 400);
  let response: Response;
  try {
    response = await fetch('https://api.akahu.io/v1' + path, {
      method, redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'X-Akahu-Id': config.appId, ...(config.accessToken ? { authorization: 'Bearer ' + config.accessToken } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch { throw new AkahuError(503); }
  if (!response.ok) {
    const retry = response.headers.get('retry-after');
    const ms = retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : retry ? Date.parse(retry) - Date.now() : 900000;
    throw new AkahuError(response.status, response.status === 429 ? new Date(Date.now() + Math.max(60000, Number.isFinite(ms) ? ms : 900000)) : undefined);
  }
  try {
    const raw = await response.text(); ensure(raw.length <= 8 * 1024 * 1024, 'Akahu response too large', 502);
    if (!raw && method === 'DELETE') return { success: true };
    const data = JSON.parse(raw); if (data.success !== true) throw new AkahuError(502); return data;
  } catch (e) { if (e instanceof AkahuError) throw e; throw new AkahuError(502); }
}
export function page(data: any) {
  ensure(Array.isArray(data.items) && (data.cursor == null || data.cursor.next == null || typeof data.cursor.next === 'string'), 'Akahu returned an invalid page; progress was not advanced.', 502);
  return { items: data.items, next: data.cursor?.next ?? null };
}
