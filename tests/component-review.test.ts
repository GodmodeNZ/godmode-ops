import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PrismaClient} from '@prisma/client';
import {catalogueCandidates,specificationConflicts,finishedPc,referenceSuggestions} from '../apps/api/src/component-evidence.js';
import {buildApp} from '../apps/api/src/app.js';
import {hashPassword} from '../apps/api/src/auth.js';
test('CSV only extracts identifiers/names and handles repeated headers and quoted descriptions',()=>{
 const rows=catalogueCandidates('Section,,,,\n,SKU,Product Name,Qty,Cost\n,A,"Fan, White",900,100\n,SKU,Product Name,Qty,Cost\n,A,Black Fan,800,200\n,,Missing identifier,100,9');
 assert.equal(rows.length,3);assert.deepEqual(Object.keys(rows[0]),['row','code','name']);assert.equal(rows[0].name,'Fan, White');assert.equal(rows[2].code,'');
 assert.throws(()=>catalogueCandidates('code,name\nA,B'),/headers/);
});
test('Similar names cannot hide colour, capacity, model and pack conflicts',()=>{
 for(const [a,b] of [['SSD 1TB Black','SSD 2TB Black'],['Fan White','Fan Black'],['RTX 4070 Black','RTX 4080 Black'],['Fan 3 Pack','Fan Single'],['Memory 32GB Kit','Memory 32GB Single']])assert.ok(specificationConflicts(a,b).length,a);
 assert.deepEqual(specificationConflicts('SSD 1TB Black','SSD 1024GB Black'),[]);
 assert.equal(finishedPc({productTitle:'Gaming PC Colossus',productType:'Desktop'}),true);
 assert.equal(finishedPc({productTitle:'Gaming PC Case White',productType:'Case'}),false);
});
test('Component review preserves stock/costs and approved invoices; imports and aliases are repeatable',async t=>{
 const db=new PrismaClient();process.env.NODE_ENV='test';process.env.WEB_ORIGIN='http://localhost:4000';const app=await buildApp(db,false);const tag=randomUUID();let cookie='';
 const post=async(path:string,payload:any,status=200,method='POST')=>{const r=await app.inject({method:method as any,url:'/api/matching/review/'+path,headers:{cookie,origin:process.env.WEB_ORIGIN,'content-type':'application/json','idempotency-key':randomUUID()},payload});assert.equal(r.statusCode,status,r.body);return r.json();};
 try{
  const user=await db.user.create({data:{email:tag+'@test.invalid',name:'Synthetic component reviewer',passwordHash:hashPassword('synthetic-component-password'),role:'ADMIN'}});
  cookie=String((await app.inject({method:'POST',url:'/api/auth/login',payload:{email:user.email,password:'synthetic-component-password'}})).headers['set-cookie']).split(';')[0];
  const family=await db.componentFamily.create({data:{name:tag,category:'SYNTHETIC'}});
  const a=await db.sku.create({data:{code:'A-'+tag,name:'Synthetic SSD 1TB Black',familyId:family.id}}),b=await db.sku.create({data:{code:'B-'+tag,name:'Synthetic SSD 2TB White',familyId:family.id}});
  await post('create-component',{code:' '+a.code.toLowerCase()+' ',name:a.name,familyId:family.id,confirmed:true},409);
  await post('create-component',{code:'C-'+tag,name:'Synthetic Fan',familyId:family.id,confirmed:true,quantity:999},400);
  const created=await post('create-component',{code:'C-'+tag,name:'Synthetic Fan',familyId:family.id,confirmed:true});assert.equal(await db.inventoryTransaction.count({where:{skuId:created.id}}),0);
  const supplier=await db.supplier.create({data:{code:tag,name:'Synthetic vendor'}});
  const make=async(status:string)=>db.supplierInvoice.create({data:{fingerprint:randomUUID(),source:'SYNTHETIC',status,supplierId:supplier.id,currency:'NZD',total:50,extractedText:'synthetic',extractionWarnings:[],lines:{create:{position:0,description:a.name,supplierCode:'VENDOR-'+tag,quantity:1,unitCost:50,lineTotal:50}}},include:{lines:true}});
  const draft=await make('REVIEW'),approved=await make('APPROVED');const stock=await db.inventoryTransaction.count();
  const csv=`SKU,Product Name,Qty,Cost\n${a.code},${a.name},500,999\n${a.code},Synthetic SSD 2TB White,999,100\n,Missing Identifier,9,88`;
  const imported=await post('import',{csv});assert.equal(imported.added,3);assert.equal((await post('import',{csv:csv.replace('500,999','7,1')})).added,0);
  const review=(await app.inject({url:'/api/matching/review',headers:{cookie}})).json();const row=review.items.find((r:any)=>r.candidateId&&r.code===a.code);assert.ok(row.candidates[0].flags.some((f:string)=>f.includes('Duplicate')));
  await post('confirm',{candidateId:row.candidateId,version:row.candidateVersion,skuId:a.id},409);
  await post('confirm',{candidateId:row.candidateId,version:row.candidateVersion,skuId:a.id,note:'Reviewed duplicate source row; existing component is correct.'});
  await post('confirm',{lineId:approved.lines[0].id,version:approved.version,skuId:a.id},409);
  await post('confirm',{lineId:draft.lines[0].id,version:draft.version,skuId:a.id,rememberAlias:true});
  const next=await make('REVIEW');assert.equal((await post('apply-aliases',{})).applied,1);assert.equal((await post('apply-aliases',{})).applied,0);
  const conflict=await make('REVIEW');await db.supplierInvoiceLine.update({where:{id:conflict.lines[0].id},data:{description:b.name}});assert.equal((await post('apply-aliases',{})).applied,0);
  const variant=await db.shopifyCatalogVariant.create({data:{shopDomain:'synthetic.myshopify.com',variantId:tag,productId:tag,productTitle:'Synthetic Gaming PC',variantTitle:'White 1TB',handle:'synthetic',vendor:'Synthetic',productType:'PC',status:'ACTIVE'}});
  await post('confirm',{lineId:next.lines[0].id,version:next.version+1,skuId:a.id,variantId:variant.id,note:'This must still be rejected as a finished PC'},409);
  assert.equal((await db.supplierInvoiceLine.findUniqueOrThrow({where:{id:approved.lines[0].id}})).confirmed,false);
  assert.equal((await db.supplierInvoice.findUniqueOrThrow({where:{id:draft.id}})).status,'REVIEW');assert.equal(await db.inventoryTransaction.count(),stock);
  assert.equal((await db.supplierInvoiceLine.findUniqueOrThrow({where:{id:draft.lines[0].id}})).unitCost?.toString(),'50');
 }finally{await app.close();await db.$disconnect();}
});

test('Cross-source suggestions work before any ERP component is linked',()=>{const records=[{id:'white',code:'PART-W',name:'Synthetic H6 Flow White'},{id:'black',code:'PART-B',name:'Synthetic H6 Flow Black'}];const matches=referenceSuggestions({description:'Synthetic H6 Flow White (MPN: PART-W)'},records);assert.equal(matches[0].id,'white');assert.equal(matches[0].score,98);assert.ok(matches[0].evidence.some(e=>e.includes('manufacturer')));assert.ok(matches.find(x=>x.id==='black')?.conflicts.some(c=>c.includes('colours')));});
