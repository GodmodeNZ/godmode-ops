import { localShopifyConfig, executeLocalShopify } from './shopify-local.js';
import type { PrismaClient, Prisma } from '@prisma/client';
import { ensure } from './core.js';
import { readConnection } from './connections.js';
export const catalogueQuery = `query OpsCatalogue($after: String) { shop { name myshopifyDomain } productVariants(first: 50, after: $after) { nodes { id title sku barcode product { id title handle productType vendor status } } pageInfo { hasNextPage endCursor } } }`;
export const connectionQuery = `query OpsConnection { shop { name myshopifyDomain } currentAppInstallation { accessScopes { handle } } }`;
export async function shopifyConfig(db?: PrismaClient | Prisma.TransactionClient) {
  const saved = db ? await readConnection(db, 'SHOPIFY') : null;
  return saved ?? localShopifyConfig() ?? { domain: process.env.SHOPIFY_STORE_DOMAIN, accessToken: process.env.SHOPIFY_ADMIN_ACCESS_TOKEN, clientId: process.env.SHOPIFY_CLIENT_ID, clientSecret: process.env.SHOPIFY_CLIENT_SECRET };
}
export async function shopifyGraphql(query: string, variables: object, db?: PrismaClient, override?: any) {
  const config = override ?? await shopifyConfig(db), shop = config.domain ?? '';
  ensure(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop), 'Connect your Shopify store in SKU Matching', 503);
  if (config.mode === 'CLI') return executeLocalShopify(config, query, variables);
  let token = config.accessToken;
  if (!token && config.clientId && config.clientSecret) {
    const r = await fetch(`https://${shop}/admin/oauth/access_token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: config.clientId, client_secret: config.clientSecret }), signal: AbortSignal.timeout(15000) });
    ensure(r.ok, `Shopify sign-in failed (${r.status}). Check the app is installed on this store.`, 502); token = (await r.json() as any).access_token;
  }
  ensure(token, 'Connect your Shopify store in SKU Matching', 503);
  const version = process.env.SHOPIFY_API_VERSION ?? '2026-07'; ensure(/^\d{4}-\d{2}$/.test(version), 'Invalid Shopify API version', 503);
  const r = await fetch(`https://${shop}/admin/api/${version}/graphql.json`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Shopify-Access-Token': token }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(20000) });
  const data = await r.json() as any; ensure(r.ok && !data.errors, `Shopify request failed: ${data.errors?.map((e: any) => e.message).join('; ') ?? r.status}`, 502); return data.data;
}
