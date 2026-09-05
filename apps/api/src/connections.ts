import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { ensure, json, type Tx } from './core.js';
function key() {
  if (process.env.INTEGRATION_ENCRYPTION_KEY) { const k = Buffer.from(process.env.INTEGRATION_ENCRYPTION_KEY, 'hex'); ensure(k.length === 32, 'INTEGRATION_ENCRYPTION_KEY must contain 64 hex characters', 503); return k; }
  const dir = resolve(process.env.ERP_DATA_DIR ?? '.data'); mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = resolve(dir, 'integration.key');
  try { return readFileSync(path); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
  try { writeFileSync(path, randomBytes(32), { flag: 'wx', mode: 0o600 }); } catch (e: any) { if (e.code !== 'EEXIST') throw e; }
  return readFileSync(path);
}
export function encrypt(value: unknown) { const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key(), iv); return (() => { const data = Buffer.concat([c.update(JSON.stringify(value)), c.final()]); return Buffer.concat([iv, c.getAuthTag(), data]).toString('base64'); })(); }
export async function readConnection(db: PrismaClient | Tx, provider: string): Promise<any | null> {
  const row = await db.integrationConnection.findUnique({ where: { provider } }); if (!row) return null;
  try { const b = Buffer.from(row.encrypted, 'base64'), c = createDecipheriv('aes-256-gcm', key(), b.subarray(0, 12)); c.setAuthTag(b.subarray(12, 28)); return JSON.parse(Buffer.concat([c.update(b.subarray(28)), c.final()]).toString()); }
  catch { throw new Error('Saved connection cannot be decrypted. Restore the original integration.key or reconnect in Settings.'); }
}
export async function saveConnection(tx: Tx, provider: string, config: unknown, metadata: unknown) { const data = { encrypted: encrypt(config), metadata: json(metadata) }; await tx.integrationConnection.upsert({ where: { provider }, create: { provider, ...data }, update: data }); }
