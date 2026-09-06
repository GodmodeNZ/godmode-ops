import { DomainError, ensure } from './core.js';

export const AKAHU_SCOPES = 'ENDURING_CONSENT ACCOUNTS TRANSACTIONS';
export class AkahuError extends DomainError {
  constructor(public providerStatus: number, public retryAt?: Date) {
    super(providerStatus === 401 ? 'Akahu access expired or was revoked. Reconnect your bank.'
      : providerStatus === 403 ? 'Akahu denied access. Check full-app permissions, eligible accounts and onboarding approval.'
      : providerStatus === 429 ? 'Akahu rate limit reached. Retry after the displayed wait time.'
      : 'Akahu could not complete the request. Saved progress is safe; retry the cached import.', 502);
  }
}
export function bankingGate(mode: string) {
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
