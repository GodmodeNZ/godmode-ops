import 'dotenv/config';
import {Prisma,PrismaClient,TrackingMode} from '@prisma/client';

if(process.env.ERP_TEST_MODE!=='true')throw Error('Legacy smoke checks are restricted to a test database. Use npm test for the full suite.');
const db=new PrismaClient();
const money=(n:number)=>new Prisma.Decimal(n);

async function balance(skuId:string,locationId:string){
  return (await db.inventoryTransaction.aggregate({where:{skuId,locationId},_sum:{quantityDelta:true}}))._sum.quantityDelta??0;
}

async function main(){
  const location=await db.location.findFirst({orderBy:{createdAt:'asc'}});
  const sku=await db.sku.findFirst({where:{active:true,trackingMode:TrackingMode.QUANTITY},include:{family:true},orderBy:{name:'asc'}});
  if(!location||!sku)throw new Error('Need at least one location and one quantity-tracked SKU');

  const supplier=await db.supplier.upsert({where:{code:'OPS-SMOKE'},update:{name:'Ops Smoke Test Supplier',active:true},create:{code:'OPS-SMOKE',name:'Ops Smoke Test Supplier'}});
  await db.supplierSku.upsert({where:{supplierId_skuId:{supplierId:supplier.id,skuId:sku.id}},update:{unitCost:money(1),currency:'NZD',preferred:false},create:{supplierId:supplier.id,skuId:sku.id,unitCost:money(1),currency:'NZD'}});

  const before=await balance(sku.id,location.id);
  const number=`SMOKE-${Date.now()}`;
  const po=await db.purchaseOrder.create({data:{number,supplierId:supplier.id,status:'ORDERED',orderedAt:new Date(),notes:'Automated net-zero procurement smoke test',lines:{create:{skuId:sku.id,quantityOrdered:1,unitCost:money(1)}}},include:{lines:true}});
  const line=po.lines[0];

  await db.$transaction(async tx=>{
    await tx.inventoryTransaction.create({data:{skuId:sku.id,locationId:location.id,quantityDelta:1,type:'PURCHASE_RECEIPT',referenceType:'PURCHASE_ORDER',referenceId:po.id,unitCost:money(1),createdBy:'PROCUREMENT_SMOKE'}});
    await tx.purchaseOrderLine.update({where:{id:line.id},data:{quantityReceived:1}});
    await tx.purchaseOrder.update({where:{id:po.id},data:{status:'RECEIVED'}});
  });

  const afterReceipt=await balance(sku.id,location.id);
  if(afterReceipt!==before+1)throw new Error(`Receipt validation failed: expected ${before+1}, got ${afterReceipt}`);

  await db.inventoryTransaction.create({data:{skuId:sku.id,locationId:location.id,quantityDelta:-1,type:'ADJUSTMENT',referenceType:'PROCUREMENT_SMOKE',referenceId:po.id,reason:'Reverse net-zero procurement smoke test',createdBy:'PROCUREMENT_SMOKE'}});
  const finalBalance=await balance(sku.id,location.id);
  if(finalBalance!==before)throw new Error(`Cleanup validation failed: expected ${before}, got ${finalBalance}`);

  console.log('PROCUREMENT SMOKE TEST PASSED');
  console.log(`PO: ${number}`);
  console.log(`SKU: ${sku.name} (${sku.family.category})`);
  console.log(`Location: ${location.name}`);
  console.log(`Balance: ${before} -> ${afterReceipt} -> ${finalBalance} (restored)`);
}

main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>db.$disconnect());
