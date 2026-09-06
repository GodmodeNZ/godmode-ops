import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PrismaClient} from '@prisma/client';
import {buildApp} from '../apps/api/src/app.js';
import {hashPassword} from '../apps/api/src/auth.js';
import {D,allocate,receiptValue,snapshot,historicalRate} from '../apps/api/src/fx.js';
import {averageCost} from '../apps/api/src/core.js';

assert.match(new URL(process.env.DATABASE_URL!).pathname,/^\/(godmode_fx_isolated_test_\d+|godmode_ops_ci_test)$/);
process.env.NODE_ENV='test';process.env.ERP_TEST_MODE='true';process.env.WEB_ORIGIN='http://localhost:5173';
const db=new PrismaClient(),app=await buildApp(db,false),prefix='fx-'+Date.now();let cookie='';
async function call(path:string,body?:any,status=200,method='POST'){
 const r=await app.inject({method:body===undefined?'GET':method as any,url:'/api'+path,headers:{cookie,origin:process.env.WEB_ORIGIN!,'content-type':'application/json','idempotency-key':randomUUID()},payload:body});
 assert.equal(r.statusCode,status,path+': '+r.body);return r.json();
}
const source={currency:'USD',fxRate:'1.6',fxRequestedDate:new Date('2026-03-08'),fxDate:new Date('2026-03-06'),fxSource:'test rate',fxConfirmed:true,fxNeedsReview:false,freight:0,tax:0,importCharges:0,paymentFees:0,costAllocation:{},total:10};
await test('NZD conversion direction, integer-cent allocation and split rounding',()=>{
 const lines=[{quantity:1,unitCost:10,lineTotal:10}];
 assert.equal(snapshot(source,lines,'2026-03-08').totalNzd,'16.00');
 assert.equal(snapshot({...source,currency:'NZD'},lines,'2026-03-08').totalNzd,'10.00');
 assert.throws(()=>snapshot({...source,fxRate:null},lines,'2026-03-08'),/exchange rate/);
 assert.throws(()=>snapshot({...source,fxRate:0},lines,'2026-03-08'),/exchange rate/);
 assert.throws(()=>snapshot({...source,fxConfirmed:false},lines,'2026-03-08'),/Confirm/);
 assert.deepEqual(allocate('.01',[1,1,1]).map(String),['0.01','0','0']);
 assert.deepEqual([0,1,2].map(i=>receiptValue(100,3,i,1).toFixed(2)),['33.33','33.34','33.33']);
 assert.equal(receiptValue(100,3,0,1).add(receiptValue(100,3,1,2)).toFixed(2),'100.00');
 assert.throws(()=>snapshot({...source,freight:1},lines,'2026-03-08'),/explicitly/);
 assert.throws(()=>snapshot({...source,freight:1,costAllocation:{freight:{method:'MANUAL',amounts:[.5]}}},lines,'2026-03-08'),/must equal/);
});
await test('historical provider direction and actual effective date; failure never substitutes 1',async()=>{
 const original=globalThis.fetch;
 try{
  globalThis.fetch=async url=>{assert.match(String(url),/2026-03-08\?base=AUD&symbols=NZD/);return new Response(JSON.stringify({base:'AUD',date:'2026-03-06',rates:{NZD:1.08}}));};
  const r=await historicalRate('AUD','2026-03-08');assert.equal(r.fxRate.toString(),'1.08');assert.equal(r.fxDate!.toISOString().slice(0,10),'2026-03-06');assert.equal(r.fxConfirmed,false);
  globalThis.fetch=async()=>new Response('{}',{status:503});await assert.rejects(historicalRate('USD','2026-03-08'),/No rate was substituted/);
  globalThis.fetch=async()=>new Response(JSON.stringify({base:'USD',date:'2026-03-09',rates:{NZD:1.6}}));await assert.rejects(historicalRate('USD','2026-03-08'),/effective date/);
 }finally{globalThis.fetch=original;}
});
await test('multi-currency invoice -> partial receiving -> BOM/build -> NZD margin',async t=>{
 try{
  const admin=await db.user.create({data:{email:prefix+'@test.invalid',name:'FX test',role:'ADMIN',passwordHash:hashPassword('isolated-test-password')}});
  const login=await app.inject({method:'POST',url:'/api/auth/login',payload:{email:admin.email,password:'isolated-test-password'}});cookie=String(login.headers['set-cookie']).split(';')[0];
  const supplier=await call('/suppliers',{code:prefix,name:prefix}),family=await call('/component-families',{name:prefix,category:'MEMORY'}),sku=await call('/skus',{code:prefix,name:'FX test component',familyId:family.id,trackingMode:'QUANTITY'}),loc=await call('/locations',{code:prefix,name:prefix});
  const imported=await call('/invoices/upload',{filename:prefix+'.csv',base64:Buffer.from('description,quantity,unitCost,lineTotal\n'+prefix+',3,10,30\n').toString('base64')});
  let inv=await call('/invoices/'+imported.id);
  function body(){return {version:inv.version,supplierId:supplier.id,invoiceNumber:prefix,invoiceDate:'2026-03-08',dueDate:null,currency:'USD',subtotal:30,tax:0,freight:1,importCharges:.5,paymentFees:.25,total:31.75,costAllocation:{freight:{method:'VALUE'},importCharges:{method:'QUANTITY'},paymentFees:{method:'EXPENSE'}},purchaseOrderId:null,lines:[{description:'FX component',quantity:3,unitCost:10,lineTotal:30,skuId:sku.id,confirmed:true}]};}
  await t.test('foreign rates are never assumed and supplier change clears SKU confirmation',async()=>{
   await call('/invoices/'+inv.id,body(),200,'PATCH');inv=await call('/invoices/'+inv.id);assert.equal(inv.fxRate,null);assert.equal(inv.fxNeedsReview,true);assert.equal(inv.lines[0].confirmed,false);
   await call('/invoices/'+inv.id,body(),200,'PATCH');inv=await call('/invoices/'+inv.id);await call('/invoices/'+inv.id+'/approve',{version:inv.version},400);
  });
  await t.test('lookup persists actual date, requires confirmation, and catches stale rate edits',async()=>{
   const original=globalThis.fetch;
   try{globalThis.fetch=async()=>new Response(JSON.stringify({base:'USD',date:'2026-03-06',rates:{NZD:1.6}}));await call('/invoices/'+inv.id+'/fx/lookup',{version:inv.version});}finally{globalThis.fetch=original;}
   const oldVersion=inv.version;inv=await call('/invoices/'+inv.id);assert.equal(inv.fxDate.slice(0,10),'2026-03-06');assert.equal(inv.fxRequestedDate.slice(0,10),'2026-03-08');await call('/invoices/'+inv.id+'/approve',{version:inv.version},400);
   await call('/invoices/'+inv.id+'/fx',{version:oldVersion,mode:'CONFIRM',confirmed:true},409,'PATCH');
   await call('/invoices/'+inv.id+'/fx',{version:inv.version,mode:'CONFIRM',confirmed:true},200,'PATCH');inv=await call('/invoices/'+inv.id);assert.equal(inv.issues.length,0);
  });
  let approved:any,po:any;
  await t.test('approval freezes conversion and original amounts; separate payment does not revalue stock',async()=>{
   await call('/invoices/'+inv.id+'/approve',{version:inv.version});approved=await call('/invoices/'+inv.id);
   assert.equal(approved.currency,'USD');assert.equal(Number(approved.lines[0].unitCost),10);assert.equal(approved.nzd.totalNzd,'50.80');assert.equal(approved.nzd.stockValueNzd,'50.40');assert.equal(approved.nzd.lines[0].stockUnitCostNzd,'16.8');
   await call('/invoices/'+inv.id+'/fx',{version:approved.version,mode:'MANUAL',rate:'2',effectiveDate:'2026-03-06',source:'changed bank quote',confirmed:true},409,'PATCH');
   await assert.rejects(db.supplierInvoice.update({where:{id:inv.id},data:{fxRate:2}}),/locked/);
   await assert.rejects(db.supplierInvoiceLine.update({where:{id:approved.lines[0].id},data:{unitCost:999}}),/locked/);
   await call('/invoices/'+inv.id+'/payments',{amountNzd:54.32,paidAt:'2026-03-09',reference:'Test bank payment'});
   const after=await call('/invoices/'+inv.id);assert.deepEqual(after.nzd,approved.nzd);assert.equal(Number(after.payments[0].amountNzd),54.32);
   po=await call('/invoices/'+inv.id+'/create-po',{number:prefix});const saved=(await call('/purchase-orders')).find((p:any)=>p.id===po.id);assert.equal(saved.currency,'USD');assert.equal(Number(saved.lines[0].unitCost),10);assert.equal(Number(saved.lines[0].stockValueNzd),50.4);assert.ok(saved.fxLockedAt);po=saved;
  });
  await t.test('partial receipts use locked allocated NZD values exactly once',async()=>{
   await call('/purchase-orders/'+po.id+'/order',{});
   await call('/purchase-orders/'+po.id+'/receive',{locationId:loc.id,lines:[{lineId:po.lines[0].id,quantity:1,serialNumbers:[]}]});
   assert.equal((await averageCost(db,sku.id)).toString(),'16.8');
   await call('/purchase-orders/'+po.id+'/receive',{locationId:loc.id,lines:[{lineId:po.lines[0].id,quantity:2,serialNumbers:[]}]});
   const movements=await db.inventoryTransaction.findMany({where:{referenceId:po.id}});assert.equal(movements.reduce((s,m)=>s.add(m.valueDeltaNzd!),D(0)).toString(),'50.4');
   await call('/purchase-orders/'+po.id+'/receive',{locationId:loc.id,lines:[{lineId:po.lines[0].id,quantity:1,serialNumbers:[]}]},409);
  });
  await t.test('BOM, completed build, stock valuation and margin all use NZD landed cost',async()=>{
   const product=await call('/products',{code:prefix,name:'FX build '+prefix}),bom=await call(`/products/${product.id}/bom-versions`,{lines:[{role:'RAM',quantity:1,exactSkuId:sku.id}]});
   const build=await call('/builds',{buildNumber:prefix,productId:product.id,bomVersionId:bom.id});
   await call(`/builds/${build.id}/reserve`,{locationId:loc.id});await call(`/builds/${build.id}/start`,{});await call(`/builds/${build.id}/qa`,{checks:{hardware:true,memory:true,storage:true,thermals:true,windows:true,cosmetic:true}});await call(`/builds/${build.id}/complete`,{unitNumber:prefix});
   await db.salesOrder.create({data:{source:'TEST',externalId:prefix,orderNumber:prefix,currency:'NZD',total:46,raw:{total_tax:'6.00'},lines:{create:{externalLineId:prefix,title:'Test PC',quantity:1,status:'RESOLVED',buildIds:[build.id]}}}});
   const report=await call('/reports');assert.equal(report.bomCosts.find((p:any)=>p.product==='FX build '+prefix).cost,16.8);assert.equal(report.buildCosts.find((p:any)=>p.buildId===build.id).cost,16.8);
   assert.equal(Number(report.valuation.find((p:any)=>p.skuId===sku.id).value),33.6);const m=report.margins.find((m:any)=>m.order===prefix);assert.equal(Number(m.revenueExTaxNzd),40);assert.equal(Number(m.marginNzd),23.2);
  });
  await t.test('manual PO rate and serialized cent remainders preserve original cost',async()=>{
   const serialSku=await call('/skus',{code:prefix+'-serial',name:'FX cent test',familyId:family.id,trackingMode:'SERIALIZED'});
   let p=await call('/purchase-orders',{number:prefix+'-cents',supplierId:supplier.id,currency:'USD',orderDate:'2026-03-08',lines:[{skuId:serialSku.id,quantityOrdered:3,unitCost:.01}]});
   await call('/purchase-orders/'+p.id+'/order',{},400);
   await call('/purchase-orders/'+p.id+'/fx',{version:p.version,mode:'MANUAL',rate:'1.5',effectiveDate:'2026-03-06',source:'Documented test manual override',confirmed:true},200,'PATCH');
   p=await call('/purchase-orders/'+p.id+'/order',{});
   await call('/purchase-orders/'+p.id+'/receive',{locationId:loc.id,lines:[{lineId:p.lines[0].id,quantity:1,serialNumbers:[prefix+'-1']}]});
   await call('/purchase-orders/'+p.id+'/receive',{locationId:loc.id,lines:[{lineId:p.lines[0].id,quantity:2,serialNumbers:[prefix+'-2',prefix+'-3']}]});
   const movements=await db.inventoryTransaction.findMany({where:{referenceId:p.id}}),units=await db.inventoryUnit.findMany({where:{skuId:serialSku.id}});
   assert.equal(movements.reduce((s,m)=>s.add(m.valueDeltaNzd!),D(0)).toFixed(2),'0.05');assert.equal(units.reduce((s,u)=>s.add(u.nzdUnitCost!),D(0)).toFixed(2),'0.05');
   assert.equal(Number(p.lines[0].unitCost),.01);
  });
  await t.test('NZD purchasing keeps identity conversion and the existing receipt behavior',async()=>{
   let p=await call('/purchase-orders',{number:prefix+'-nzd',supplierId:supplier.id,lines:[{skuId:sku.id,quantityOrdered:2,unitCost:25}]});p=await call('/purchase-orders/'+p.id+'/order',{});assert.equal(Number(p.fxRate),1);assert.equal(p.nzdSnapshot.stockValueNzd,'50.00');
   await call('/purchase-orders/'+p.id+'/receive',{locationId:loc.id,lines:[{lineId:p.lines[0].id,quantity:2,serialNumbers:[]}]});
   const m=await db.inventoryTransaction.findFirstOrThrow({where:{referenceId:p.id}});assert.equal(Number(m.valueDeltaNzd),50);
  });
  await t.test('additive migration flags foreign history and preserves NZD amounts',async()=>{
   const old=await db.supplierInvoice.findUnique({where:{id:'fx-legacy-aud'}});if(!old)return; // CI starts with the current schema; local migration harness supplies fixtures.
   assert.equal(old.fxRate,null);assert.equal(old.fxNeedsReview,true);assert.equal(Number(old.total),100);assert.equal(old.currency,'AUD');
   const nz=await db.supplierInvoice.findUniqueOrThrow({where:{id:'fx-legacy-nzd'}});assert.equal(Number(nz.fxRate),1);assert.equal(nz.fxNeedsReview,false);assert.equal(Number(nz.total),115);
   const legacy=await call('/purchase-orders');assert.equal(legacy.find((p:any)=>p.id==='fx-legacy-po').fxNeedsReview,true);
   await call('/purchase-orders/fx-legacy-po/receive',{locationId:'fx-legacy-location',lines:[{lineId:'fx-legacy-pol',quantity:1,serialNumbers:[]}]},400);
   await assert.rejects(averageCost(db,'fx-legacy-sku'),/requires valuation review/);
   const report=await call('/reports');const row=report.valuation.find((v:any)=>v.skuId==='fx-legacy-sku');assert.equal(row.value,null);assert.equal(row.needsReview,true);
   const movement=await db.inventoryTransaction.findUniqueOrThrow({where:{id:'fx-legacy-movement'}});assert.equal(Number(movement.unitCost),10);assert.equal(movement.valueDeltaNzd,null);
  });
 }finally{await app.close();await db.$disconnect();}
});
