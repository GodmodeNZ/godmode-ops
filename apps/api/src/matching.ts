import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actor, ensure, mutate, type Tx } from './core.js';
import { saveConnection } from './connections.js';
import { catalogueQuery, connectionQuery, shopifyConfig, shopifyGraphql } from './shopify-client.js';
export const normalize = (s: string | null | undefined) => (s ?? '').normalize('NFKC').trim().toUpperCase().replace(/\s+/g, ' ');
const id = z.string().min(1).max(200);
const domain = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/);
export const catalogueSchema = z.object({ shopDomain: domain, exportedAt: z.string().datetime(), complete: z.boolean().default(false), variants: z.array(z.object({ id, title: z.string(), sku: z.string().nullable(), barcode: z.string().nullable(), product: z.object({ id, title: z.string(), handle: z.string(), productType: z.string(), vendor: z.string(), status: z.enum(['ACTIVE','DRAFT','ARCHIVED']) }) })).max(20000) });
export async function importCatalogue(tx: Tx, b: z.infer<typeof catalogueSchema>) {
  ensure(new Set(b.variants.map(v => v.id)).size === b.variants.length, 'Duplicate Shopify variant IDs', 400);
  const latest = await tx.shopifyCatalogVariant.findFirst({ where: { shopDomain: b.shopDomain }, orderBy: { syncedAt: 'desc' } });
  ensure(!latest || new Date(b.exportedAt) >= latest.syncedAt, 'This catalogue snapshot is older than the current catalogue', 409);
  if (b.complete) await tx.shopifyCatalogVariant.updateMany({ where: { shopDomain: b.shopDomain }, data: { present: false } });
  for (const v of b.variants) {
    const data = { productId: v.product.id, productTitle: v.product.title, variantTitle: v.title, handle: v.product.handle, vendor: v.product.vendor, productType: v.product.productType, status: v.product.status, shopifySku: v.sku, barcode: v.barcode, present: true, syncedAt: new Date(b.exportedAt) };
    await tx.shopifyCatalogVariant.upsert({ where: { shopDomain_variantId: { shopDomain: b.shopDomain, variantId: v.id } }, create: { shopDomain: b.shopDomain, variantId: v.id, ...data }, update: data });
  }
  return { imported: b.variants.length, shopDomain: b.shopDomain, complete: b.complete };
}
export async function matchContext(db: PrismaClient | Tx) {
  const [skus, aliases, variants, quotes] = await Promise.all([db.sku.findMany({ where: { active: true }, include: { barcodes: true } }), db.supplierAlias.findMany({ include: { supplier: true } }), db.shopifyCatalogVariant.findMany(), db.supplierSku.findMany()]);
  return { skus, aliases, variants, quotes };
}
export function suggestMatch(ctx: Awaited<ReturnType<typeof matchContext>>, input: { description: string; supplierCode?: string | null; barcode?: string | null }, supplierId?: string | null) {
  const evidence = new Map<string, { skuId: string; reasons: string[]; score: number; exact: boolean }>();
  const add = (skuId: string, reason: string, score: number, exact = true) => { if (!ctx.skus.some(s => s.id === skuId)) return; const old = evidence.get(skuId); evidence.set(skuId, { skuId, reasons: [...(old?.reasons ?? []), reason], score: Math.max(old?.score ?? 0, score), exact: (old?.exact ?? false) || exact }); };
  for (const a of ctx.aliases) if (a.supplierId === supplierId && ((a.kind === 'CODE' && input.supplierCode && a.key === normalize(input.supplierCode)) || (a.kind === 'NAME' && a.key === normalize(input.description)))) add(a.skuId, `Confirmed supplier ${a.kind === 'CODE' ? 'code' : 'name'} alias: ${a.value}`, 100);
  for (const q of ctx.quotes) if (q.supplierId === supplierId && input.supplierCode && q.supplierCode && normalize(q.supplierCode) === normalize(input.supplierCode)) add(q.skuId, 'Exact supplier part code on a supplier quote', 98);
  for (const s of ctx.skus) {
    if (input.supplierCode && normalize(s.code) === normalize(input.supplierCode)) add(s.id, 'Exact ERP SKU code', 97);
    if (input.barcode && s.barcodes.some(b => b.value === input.barcode)) add(s.id, 'Exact barcode', 99);
    for (const v of ctx.variants.filter(v => v.skuId === s.id && v.confirmedAt && v.present && v.status !== 'ARCHIVED')) {
      if (input.supplierCode && v.shopifySku && normalize(v.shopifySku) === normalize(input.supplierCode)) add(s.id, 'Exact Shopify SKU on a confirmed Shopify link', 97);
      if (input.barcode && v.barcode === input.barcode) add(s.id, 'Exact Shopify barcode on a confirmed Shopify link', 99);
    }
    const a = new Set(normalize(input.description).replace(/[^A-Z0-9]+/g,' ').split(' ').filter(t=>t.length>1)), b = new Set(normalize(s.name).replace(/[^A-Z0-9]+/g,' ').split(' ').filter(t=>t.length>1));
    const shared = [...a].filter(t=>b.has(t)).length, score = shared / Math.max(a.size,b.size,1);
    if (score >= 0.3) add(s.id, 'Similar name only — check model, capacity, colour and kit size', Math.round(score*75), false);
  }
  const candidates = [...evidence.values()].sort((a,b)=>b.score-a.score).map(m => ({ ...m, sku: ctx.skus.find(s=>s.id===m.skuId), shopify: ctx.variants.filter(v=>v.skuId===m.skuId && v.confirmedAt) }));
  const exact = candidates.filter(c=>c.exact); return { suggestedSkuId: exact.length===1 ? exact[0].skuId : null, ambiguous: exact.length>1, reason: exact.length>1 ? 'Conflicting identifiers point to different SKUs. Choose the correct component.' : candidates[0]?.reasons.join('; ') ?? 'No matching identifiers. Select a component.', candidates: candidates.slice(0,5) };
}
export async function registerMatching(app: FastifyInstance, db: PrismaClient) {
  app.get('/matching', async () => { const ctx = await matchContext(db); const rows = ctx.variants.map(v => {
    const exact = ctx.skus.filter(s => (v.shopifySku && normalize(s.code)===normalize(v.shopifySku)) || (v.barcode && s.barcodes.some(b=>b.value===v.barcode)) || String((s.attributes as any)?.shopifyVariantId)===v.variantId.split('/').pop());
    return { ...v, linkedSku: ctx.skus.find(s=>s.id===v.skuId), candidates: exact.map(s=>({id:s.id,code:s.code,name:s.name})), reason: v.confirmedAt ? 'Manually confirmed Shopify variant link' : exact.length===1 ? 'Exact code, barcode or previously imported variant ID — awaiting confirmation' : exact.length>1 ? 'Conflicting identifiers — choose the correct SKU' : 'No exact match — choose or create a component' };
  }); return { variants: rows, aliases: ctx.aliases, rules: ['Supplier-specific confirmed alias', 'Exact supplier part code', 'Exact ERP or confirmed Shopify SKU / barcode', 'Similar names are suggestions only'] }; });
  app.post('/matching/shopify/import', { bodyLimit: 12*1024*1024 }, async q => { const b = catalogueSchema.parse(q.body); return mutate(db,q,'Import Shopify catalogue snapshot',tx=>importCatalogue(tx,b)); });
  app.post('/matching/shopify/sync', async q => { const variants: any[]=[]; let after=null; let shopDomain=''; do { const data=await shopifyGraphql(catalogueQuery,{after},db); variants.push(...data.productVariants.nodes); shopDomain=data.shop.myshopifyDomain; after=data.productVariants.pageInfo.hasNextPage ? data.productVariants.pageInfo.endCursor : null; ensure(variants.length<=20000,'Catalogue exceeds 20,000 variants; narrow the sync',409); } while(after); return mutate(db,q,'Sync Shopify catalogue',tx=>importCatalogue(tx,catalogueSchema.parse({variants,shopDomain,exportedAt:new Date().toISOString(),complete:true}))); });
  app.post('/matching/shopify/connect', async q => {
    const b=z.object({domain,accessToken:z.string().min(10).optional(),clientId:z.string().min(1).optional(),clientSecret:z.string().min(1).optional()}).parse(q.body);
    ensure(b.accessToken || (b.clientId && b.clientSecret),'Supply the app access token, or its client ID and secret',400);
    const data=await shopifyGraphql(connectionQuery,{},undefined,b); ensure(data.shop.myshopifyDomain===b.domain,'The credentials belong to a different store',409);
    const scopes=data.currentAppInstallation.accessScopes.map((s:any)=>s.handle); ensure(scopes.includes('read_products')||scopes.includes('write_products'),'The app needs product read access',403);
    const metadata={domain:b.domain,name:data.shop.name,verifiedAt:new Date().toISOString(),scopes};
    return mutate(db,q,'Connect Shopify read access',async tx=>{await saveConnection(tx,'SHOPIFY',b,metadata);return metadata;});
  });
  app.post('/matching/shopify/check', async q => { const c=await shopifyConfig(db), data=await shopifyGraphql(connectionQuery,{},db); return {domain:c.domain,name:data.shop.name,verifiedAt:new Date().toISOString(),scopes:data.currentAppInstallation.accessScopes.map((s:any)=>s.handle)}; });
  app.patch('/matching/shopify/:id', async q => { const b=z.object({skuId:id.nullable()}).parse(q.body), {id:variantId}=q.params as any; return mutate(db,q,'Confirm Shopify component link',async tx=>{ if(b.skuId) ensure((await tx.sku.findUnique({where:{id:b.skuId}}))?.active,'Choose an active SKU',400); return tx.shopifyCatalogVariant.update({where:{id:variantId},data:{skuId:b.skuId,confirmedBy:b.skuId?actor(q):null,confirmedAt:b.skuId?new Date():null,matchMethod:b.skuId?'MANUAL':null}}); }); });
  app.post('/matching/shopify/:id/create-sku', async q => { const b=z.object({code:id,familyId:id,trackingMode:z.enum(['SERIALIZED','QUANTITY'])}).parse(q.body), {id:variantId}=q.params as any; return mutate(db,q,'Create component from Shopify variant',async tx=>{const v=await tx.shopifyCatalogVariant.findUniqueOrThrow({where:{id:variantId}});ensure(!v.skuId,'This variant already has a component link'); const s=await tx.sku.create({data:{...b,name:v.productTitle+(v.variantTitle==='Default Title'?'':' · '+v.variantTitle),attributes:{shopifyVariantId:v.variantId.split('/').pop(),shopifyProductId:v.productId.split('/').pop()},barcodes:v.barcode?{create:{value:v.barcode}}:undefined}});await tx.shopifyCatalogVariant.update({where:{id:v.id},data:{skuId:s.id,confirmedBy:actor(q),confirmedAt:new Date(),matchMethod:'MANUAL'}});return s;}); });
  app.post('/matching/aliases', async q => { const b=z.object({supplierId:id,skuId:id,kind:z.enum(['CODE','NAME']),value:z.string().trim().min(1).max(500)}).parse(q.body);return mutate(db,q,'Confirm supplier alias',async tx=>{ensure((await tx.sku.findUnique({where:{id:b.skuId}}))?.active,'Choose an active SKU',400);return tx.supplierAlias.upsert({where:{supplierId_kind_key:{supplierId:b.supplierId,kind:b.kind,key:normalize(b.value)}},create:{...b,key:normalize(b.value),confirmedBy:actor(q)},update:{skuId:b.skuId,value:b.value,confirmedBy:actor(q)}});}); });
  app.delete('/matching/aliases/:id', async q=>mutate(db,q,'Remove supplier alias',tx=>tx.supplierAlias.delete({where:{id:(q.params as any).id}})));
}
