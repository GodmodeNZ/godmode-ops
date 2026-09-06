import {createHash,randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import type {PrismaClient} from '@prisma/client';
import {z} from 'zod';
import {actor,ensure,mutate} from './core.js';
import {matchContext,normalize,suggestMatch} from './matching.js';
import {catalogueCandidates,finishedPc,specificationConflicts} from './component-evidence.js';
const allCandidates=(db:any):Promise<any[]>=>db.$queryRaw`SELECT * FROM "CatalogueCandidate" ORDER BY "createdAt", "sourceRow"`;
export async function stageCandidates(tx:any,csv:string){
  let rows;try{rows=catalogueCandidates(csv);}catch(e){ensure(false,(e as Error).message,400);}ensure(rows!.length<=10000,'At most 10,000 candidate rows',400);
  // Quantity/cost changes cannot change identity or cause a second import.
  const batch=createHash('sha256').update(JSON.stringify(rows!.map(r=>[r.row,r.code,r.name]))).digest('hex');let added=0;
  for(const r of rows!)added+=await tx.$executeRaw`INSERT INTO "CatalogueCandidate" (id,batch,"sourceRow",code,name) VALUES (${randomUUID()},${batch},${r.row},${r.code},${r.name}) ON CONFLICT (batch,"sourceRow") DO NOTHING`;
  return {candidates:rows!.length,added,duplicate:added===0,ignored:'All quantities and costs'};
}
function rowFlags(row:any,rows:any[],skus:any[]){
 const flags:string[]=[];if(!row.code)flags.push('Missing SKU identifier');if(!row.name)flags.push('Missing product description');
 const duplicate=rows.filter(x=>row.code&&normalize(x.code)===normalize(row.code));if(duplicate.length>1)flags.push('Duplicate spreadsheet code — review each row');
 if(duplicate.some(x=>normalize(x.name)!==normalize(row.name)))flags.push('Same spreadsheet code has conflicting descriptions');
 const exact=skus.filter(x=>row.code&&normalize(x.code)===normalize(row.code));if(exact.length>1)flags.push('Duplicate normalized ERP codes');
 for(const s of exact){if(normalize(s.name)!==normalize(row.name))flags.push('ERP code exists with a different description');flags.push(...specificationConflicts(row.name,s.name));}return [...new Set(flags)];
}
export async function registerComponentReview(app:FastifyInstance,db:PrismaClient){
 app.addHook('preHandler',async q=>{
  const match=q.url.split('?')[0].match(/^\/api\/matching\/shopify\/([^/]+)(\/create-sku)?$/);
  if(!match||!['POST','PATCH'].includes(q.method)||(q.body as any)?.skuId===null)return;
  const v=await db.shopifyCatalogVariant.findUnique({where:{id:decodeURIComponent(match[1])}});if(!v)return;
  const mappings=await db.shopifyProductMapping.findMany({where:{shopDomain:v.shopDomain,active:true}});
  ensure(!finishedPc(v)&&!mappings.some(m=>m.shopifyVariantId===v.variantId.split('/').pop()||(!m.shopifyVariantId&&m.shopifyProductId===v.productId.split('/').pop())),'Finished PCs must link to BOM products, not individual components',409);
 });
 app.post('/matching/review/import',{bodyLimit:8*1024*1024},async q=>{const b=z.object({csv:z.string().max(8*1024*1024)}).strict().parse(q.body);return mutate(db,q,'Stage catalogue names and SKU codes only',tx=>stageCandidates(tx,b.csv));});
 app.post('/matching/review/create-component',async q=>{const b=z.object({code:z.string().trim().min(1).max(200),name:z.string().trim().min(1).max(500),familyId:z.string(),confirmed:z.literal(true)}).strict().parse(q.body);return mutate(db,q,'Explicitly create reviewed catalogue component without stock or cost',async tx=>{ensure(!finishedPc({productTitle:b.name,productType:''}),'Finished PCs belong to a product/BOM',409);ensure(!(await tx.sku.findMany({select:{code:true}})).some(s=>normalize(s.code)===normalize(b.code)),'That normalized component code already exists. Select the existing component; no duplicate was created.',409);return tx.sku.create({data:{code:b.code,name:b.name,familyId:b.familyId,trackingMode:'QUANTITY'}});});});
 app.get('/matching/review',async()=>{
  const [rows,ctx,lines,products,mappings]=await Promise.all([allCandidates(db),matchContext(db),db.supplierInvoiceLine.findMany({where:{invoice:{status:'REVIEW'}},include:{invoice:{include:{supplier:true}}},orderBy:{position:'asc'}}),db.product.findMany({where:{active:true},include:{bomVersions:{where:{active:true},include:{lines:true}}}}),db.shopifyProductMapping.findMany({where:{active:true}})]);
  const candidates=rows.map(r=>({...r,flags:rowFlags(r,rows,ctx.skus),suggestion:suggestMatch(ctx,{description:r.name,supplierCode:r.code})}));
  const items=[...lines.map(l=>({id:'line:'+l.id,lineId:l.id,invoiceVersion:l.invoice.version,invoiceNumber:l.invoice.invoiceNumber,supplier:l.invoice.supplier?.name,supplierId:l.invoice.supplierId,code:l.supplierCode,description:l.description,skuId:l.skuId,confirmed:l.confirmed,candidates:candidates.filter(c=>(c.code&&normalize(c.code)===normalize(l.supplierCode))||(c.skuId&&c.skuId===l.skuId)),suggestion:suggestMatch(ctx,l,l.invoice.supplierId)})),...candidates.map(c=>({id:'candidate:'+c.id,candidateId:c.id,candidateVersion:c.version,code:c.code,description:c.name,skuId:c.skuId,confirmed:Boolean(c.confirmedAt),counted:c.counted,candidates:[c],suggestion:c.suggestion}))];
  items.sort((a:any,b:any)=>Number(Boolean(b.lineId||b.counted))-Number(Boolean(a.lineId||a.counted))||Number(a.confirmed)-Number(b.confirmed));
  return {items,skus:ctx.skus,families:await db.componentFamily.findMany({orderBy:{name:'asc'}}),variants:ctx.variants.map(v=>({...v,finished:finishedPc(v)||mappings.some(m=>m.shopDomain===v.shopDomain&&(m.shopifyVariantId===v.variantId.split('/').pop()||(!m.shopifyVariantId&&m.shopifyProductId===v.productId.split('/').pop())))})),products,progress:{total:items.length,confirmed:items.filter(x=>x.confirmed).length,unresolved:items.filter(x=>!x.confirmed).length,counted:candidates.filter(c=>c.counted).length},catalogueSyncedAt:ctx.variants.map(v=>v.syncedAt).sort().at(-1)};
 });
 app.patch('/matching/review/counted',async q=>{const b=z.object({id:z.string(),version:z.number().int(),counted:z.boolean()}).parse(q.body);return mutate(db,q,'Mark catalogue candidate counted for review priority',async tx=>{const n=await tx.$executeRaw`UPDATE "CatalogueCandidate" SET counted=${b.counted},version=version+1 WHERE id=${b.id} AND version=${b.version}`;ensure(n===1,'Candidate changed. Refresh first.');return {saved:true};});});
 app.post('/matching/review/confirm',async q=>{
  const b=z.object({lineId:z.string().optional(),candidateId:z.string().optional(),version:z.number().int(),skuId:z.string(),variantId:z.string().optional(),rememberAlias:z.boolean().default(false),replaceAliasSkuId:z.string().optional(),note:z.string().trim().max(1000).default('')}).strict().parse(q.body);
  ensure(Boolean(b.lineId)!==Boolean(b.candidateId),'Select one review row',400);
  return mutate(db,q,'Confirm component review mapping without approval or receiving',async tx=>{
   const sku=await tx.sku.findUniqueOrThrow({where:{id:b.skuId}});ensure(sku.active,'Select an active component',400);
   const line=b.lineId?await tx.supplierInvoiceLine.findUniqueOrThrow({where:{id:b.lineId},include:{invoice:true}}):null;
   const candidate=b.candidateId?(await allCandidates(tx)).find(x=>x.id===b.candidateId):null;
   if(line)ensure(line.invoice.status==='REVIEW'&&line.invoice.version===b.version&&!line.invoice.purchaseOrderId,'Only unchanged draft invoice lines can be mapped',409);
   else ensure(candidate&&candidate.version===b.version,'Candidate changed. Refresh first.',409);
   const description=line?.description??candidate.name;
   const conflicts=specificationConflicts(description,sku.name);
   if(candidate)conflicts.push(...rowFlags(candidate,await allCandidates(tx),await tx.sku.findMany()));
   ensure(!conflicts.length||b.note.length>=10,'Explain how each conflicting specification/identifier was resolved (at least 10 characters).',409);
   if(b.variantId){const v=await tx.shopifyCatalogVariant.findUniqueOrThrow({where:{id:b.variantId}});ensure(v.present&&v.status!=='ARCHIVED','Select an available Shopify variant',409);const builds=await tx.shopifyProductMapping.findMany({where:{shopDomain:v.shopDomain,active:true}});ensure(!finishedPc(v)&&!builds.some(m=>m.shopifyVariantId===v.variantId.split('/').pop()||(!m.shopifyVariantId&&m.shopifyProductId===v.productId.split('/').pop())),'Finished PCs must link to a build BOM, not a component',409);ensure(!v.skuId||v.skuId===sku.id||b.note.length>=10,'Explain correction of the existing Shopify component link',409);ensure(!specificationConflicts(description,v.productTitle+' '+v.variantTitle).length||b.note.length>=10,'Resolve Shopify variant specifications first',409);await tx.shopifyCatalogVariant.update({where:{id:v.id},data:{skuId:sku.id,confirmedAt:new Date(),confirmedBy:actor(q),matchMethod:'REVIEW'}});}
   if(b.rememberAlias){ensure(line?.invoice.supplierId&&line.supplierCode,'Supplier and invoice code are required for a supplier alias',400);const key=normalize(line.supplierCode);const old=await tx.supplierAlias.findUnique({where:{supplierId_kind_key:{supplierId:line.invoice.supplierId,kind:'CODE',key}}});ensure(!old||old.skuId===sku.id||(old.skuId===b.replaceAliasSkuId&&b.note.length>=10),'Supplier code already maps to a different component. Enter its current component ID and explain the correction.',409);await tx.supplierAlias.upsert({where:{supplierId_kind_key:{supplierId:line.invoice.supplierId,kind:'CODE',key}},create:{supplierId:line.invoice.supplierId,kind:'CODE',key,value:line.supplierCode,skuId:sku.id,confirmedBy:actor(q)},update:{skuId:sku.id,confirmedBy:actor(q)}});}
   if(line){await tx.supplierInvoiceLine.update({where:{id:line.id},data:{skuId:sku.id,confirmed:true,matchReason:'Confirmed component review: '+b.note}});await tx.supplierInvoice.update({where:{id:line.invoiceId},data:{version:{increment:1}}});}
   else await tx.$executeRaw`UPDATE "CatalogueCandidate" SET "skuId"=${sku.id},"confirmedAt"=CURRENT_TIMESTAMP,"confirmedBy"=${actor(q)},version=version+1 WHERE id=${candidate.id}`;
   await tx.auditLog.create({data:{actor:actor(q),action:'Component mapping evidence',reference:JSON.stringify({lineId:b.lineId,candidateId:b.candidateId,skuId:sku.id,conflicts,note:b.note})}});return {saved:true};
  });
 });
 app.post('/matching/review/apply-aliases',async q=>mutate(db,q,'Apply confirmed supplier code aliases to eligible draft lines',async tx=>{
  const ctx=await matchContext(tx);const lines=await tx.supplierInvoiceLine.findMany({where:{confirmed:false,invoice:{status:'REVIEW',purchaseOrderId:null}},include:{invoice:true}});let applied=0;const changed=new Set<string>();
  for(const l of lines){const a=ctx.aliases.find(a=>a.supplierId===l.invoice.supplierId&&a.kind==='CODE'&&a.key===normalize(l.supplierCode));if(!a)continue;const suggestion=suggestMatch(ctx,l,l.invoice.supplierId);if(suggestion.suggestedSkuId!==a.skuId||suggestion.ambiguous)continue;await tx.supplierInvoiceLine.update({where:{id:l.id},data:{skuId:a.skuId,confirmed:true,matchReason:'Confirmed supplier code alias; specifications checked'}});changed.add(l.invoiceId);applied++;}
  for(const id of changed)await tx.supplierInvoice.update({where:{id},data:{version:{increment:1}}});return {applied,skipped:lines.length-applied};
 }));
 app.post('/matching/review/build-link',async q=>{const b=z.object({variantId:z.string(),productId:z.string()}).parse(q.body);return mutate(db,q,'Link exact Shopify finished-PC variant to BOM product',async tx=>{const v=await tx.shopifyCatalogVariant.findUniqueOrThrow({where:{id:b.variantId}});ensure(!v.skuId,'Remove the existing component link before classifying this variant as a finished PC',409);ensure(await tx.bomVersion.count({where:{productId:b.productId,active:true,lines:{some:{}}}}),'Choose a product with an active non-empty BOM',400);const old=await tx.shopifyProductMapping.findMany({where:{shopDomain:v.shopDomain,shopifyVariantId:v.variantId.split('/').pop(),active:true}});ensure(!old.some(m=>m.productId!==b.productId),'A conflicting active BOM mapping already exists; correct it in Settings',409);if(old.length)return {saved:true,duplicate:true};await tx.shopifyProductMapping.create({data:{shopDomain:v.shopDomain,shopifyVariantId:v.variantId.split('/').pop(),productId:b.productId}});return {saved:true};});});
}
