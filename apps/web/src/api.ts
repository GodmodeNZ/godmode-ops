const pending = new Map<string, string>();
export async function api(path: string, body?: unknown, method = 'POST') {
  const fingerprint = path + JSON.stringify(body) + method;
  const headers: Record<string, string> = {};
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    if (!pending.has(fingerprint)) pending.set(fingerprint, crypto.randomUUID());
    headers['Idempotency-Key'] = pending.get(fingerprint)!;
  }
  const r = await fetch('/api' + path, { method: body === undefined ? 'GET' : method, credentials: 'include', headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json();
  if (!r.ok) { if (r.status < 500) pending.delete(fingerprint); if (r.status === 401) window.dispatchEvent(new Event('signed-out')); throw new Error(data.error ?? `Request failed (${r.status})`); }
  pending.delete(fingerprint); return data;
}
export const money = (n: unknown) => new Intl.NumberFormat('en-NZ', { style: 'currency', currency: 'NZD' }).format(Number(n ?? 0));
export const date = (d: string) => d ? new Intl.DateTimeFormat('en-NZ', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Pacific/Auckland' }).format(new Date(d)) : '—';
export const label = (s: string) => (s ?? '').replace(/_/g, ' ').toLowerCase().replace(/^./, c => c.toUpperCase());
export function exportCsv(name: string, rows: any[]) {
  if (!rows.length) return;
  const safe = (value: any) => { let s = String(value ?? ''); if (/^[=+@\-\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
  const keys = Object.keys(rows[0]); const csv = [keys, ...rows.map(r => keys.map(k => r[k]))].map(row => row.map(safe).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' })); const a = document.createElement('a'); a.href = url; a.download = name + '.csv'; a.click(); URL.revokeObjectURL(url);
}
