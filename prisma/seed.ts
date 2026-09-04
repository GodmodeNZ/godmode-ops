import {PrismaClient,Prisma} from '@prisma/client';
const db=new PrismaClient();
const parts=[
 {family:'Ryzen 5 7500F',category:'CPU',code:'TEST-CPU-7500F',name:'AMD Ryzen 5 7500F',cost:240},
 {family:'RTX 5060 8GB',category:'GPU',code:'TEST-GPU-5060',name:'GeForce RTX 5060 8GB',cost:600},
 {family:'32GB DDR5-6000',category:'RAM',code:'TEST-RAM-32-6000',name:'32GB DDR5-6000 Kit',cost:150},
 {family:'1TB NVMe SSD',category:'SSD',code:'TEST-SSD-1TB',name:'1TB NVMe SSD',cost:90},
 {family:'B850 WiFi Motherboard',category:'MOTHERBOARD',code:'TEST-MB-B850',name:'B850 WiFi Motherboard',cost:220}
];
async function main(){
 const location=await db.location.upsert({where:{code:'MAIN'},update:{name:'Main Warehouse'},create:{code:'MAIN',name:'Main Warehouse'}});
 const skus=[];
 for(const p of parts){
  const family=await db.componentFamily.upsert({where:{name:p.family},update:{category:p.category},create:{name:p.family,category:p.category}});
  const sku=await db.sku.upsert({where:{code:p.code},update:{name:p.name,familyId:family.id,active:true},create:{code:p.code,name:p.name,familyId:family.id}});skus.push(sku);
  const existing=await db.inventoryTransaction.findFirst({where:{skuId:sku.id,locationId:location.id,referenceType:'DEMO_SEED',referenceId:'DEMO-M3'}});
  if(!existing)await db.inventoryTransaction.create({data:{skuId:sku.id,locationId:location.id,quantityDelta:10,type:'PURCHASE_RECEIPT',referenceType:'DEMO_SEED',referenceId:'DEMO-M3',unitCost:new Prisma.Decimal(p.cost),reason:'Godmode Ops demo seed',createdBy:'seed'}});
 }
 const product=await db.product.upsert({where:{code:'TEST-COLOSSUS'},update:{name:'Test Colossus',active:true},create:{code:'TEST-COLOSSUS',name:'Test Colossus'}});
 let bom=await db.bomVersion.findFirst({where:{productId:product.id,version:1}});
 if(!bom)bom=await db.bomVersion.create({data:{productId:product.id,version:1,lines:{create:[
  {role:'CPU',quantity:1,lineType:'EXACT_SKU',exactSkuId:skus[0].id},
  {role:'GPU',quantity:1,lineType:'EXACT_SKU',exactSkuId:skus[1].id},
  {role:'RAM',quantity:1,lineType:'EXACT_SKU',exactSkuId:skus[2].id},
  {role:'SSD',quantity:1,lineType:'EXACT_SKU',exactSkuId:skus[3].id},
  {role:'MOTHERBOARD',quantity:1,lineType:'EXACT_SKU',exactSkuId:skus[4].id}
 ]}}});
 const mapping=await db.shopifyProductMapping.findFirst({where:{sku:'TEST-COLOSSUS',productId:product.id}});
 if(!mapping)await db.shopifyProductMapping.create({data:{sku:'TEST-COLOSSUS',productId:product.id,priority:1}});
 console.log('Demo seed ready:',{location:location.name,product:product.name,bomVersion:bom.version,stockPerSku:10,shopifySku:'TEST-COLOSSUS'});
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>db.$disconnect());