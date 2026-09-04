import {PrismaClient,ReservationStatus,TrackingMode} from '@prisma/client';
import type {ShopifyOrder,ShopifyLine} from './shopify.js';

const idString=(v:unknown)=>v===null||v===undefined?undefined:String(v);
const props=(line:ShopifyLine)=>Object.fromEntries((line.properties??[]).filter(p=>p.name).map(p=>[p.name,String(p.value??'')]));

async function findMapping(db:PrismaClient,line:ShopifyLine,shopDomain?:string){
  const variantId=idString(line.variant_id),productId=idString(line.product_id),sku=line.sku||undefined;
  const ors:any[]=[];
  if(variantId)ors.push({shopifyVariantId:variantId});
  if(productId)ors.push({shopifyProductId:productId,shopifyVariantId:null});
  if(sku)ors.push({sku,shopifyVariantId:null,shopifyProductId:null});
  if(!ors.length)return null;
  return db.shopifyProductMapping.findFirst({
    where:{active:true,OR:ors,AND:[{OR:[{shopDomain},{shopDomain:null}]}]},
    orderBy:{priority:'asc'},
    include:{product:true,configurationRules:{include:{replacementSku:true}}}
  });
}

async function availability(db:PrismaClient,skuId:string,locationId?:string){
  const sku=await db.sku.findUniqueOrThrow({where:{id:skuId}});
  if(!locationId)return{available:null,onHand:null,reserved:null};
  if(sku.trackingMode===TrackingMode.SERIALIZED){
    const onHand=await db.inventoryUnit.count({where:{skuId,locationId,consumedAt:null}});
    const reserved=await db.inventoryReservation.count({where:{skuId,locationId,status:ReservationStatus.ACTIVE,inventoryUnitId:{not:null}}});
    return{onHand,reserved,available:onHand-reserved};
  }
  const onHand=(await db.inventoryTransaction.aggregate({where:{skuId,locationId},_sum:{quantityDelta:true}}))._sum.quantityDelta??0;
  const reserved=(await db.inventoryReservation.aggregate({where:{skuId,locationId,status:ReservationStatus.ACTIVE},_sum:{quantity:true}}))._sum.quantity??0;
  return{onHand,reserved,available:onHand-reserved};
}

export async function dryRunShopifyOrder(db:PrismaClient,order:ShopifyOrder,shopDomain?:string,locationId?:string){
  const lines=[] as any[];
  let blocked=false,buildCount=0;
  for(const line of order.line_items??[]){
    const mapping=await findMapping(db,line,shopDomain);
    if(!mapping){blocked=true;lines.push({title:line.name??line.title??'Shopify item',sku:line.sku,quantity:line.quantity,ok:false,mappingStatus:'No mapping',message:'No Shopify product mapping',components:[]});continue;}
    const bom=await db.bomVersion.findFirst({where:{productId:mapping.productId,active:true},orderBy:{version:'desc'},include:{lines:{include:{exactSku:true,approvedSkus:{include:{sku:true},orderBy:{priority:'asc'}}}}}});
    if(!bom){blocked=true;lines.push({title:line.name??line.title??'Shopify item',sku:line.sku,quantity:line.quantity,ok:false,productName:mapping.product.name,message:'Mapped product has no active BOM',components:[]});continue;}
    const propertyMap=props(line);const overrides=new Map<string,{skuId:string;skuCode:string;skuName:string;quantity?:number}>();
    for(const rule of mapping.configurationRules){if(String(propertyMap[rule.propertyName]??'')===rule.propertyValue)overrides.set(rule.role,{skuId:rule.replacementSkuId,skuCode:rule.replacementSku.code,skuName:rule.replacementSku.name,quantity:rule.quantity??undefined});}
    const components=[] as any[];let lineOk=true;const messages:string[]=[];
    for(const bl of bom.lines){
      const override=overrides.get(bl.role);const chosen=override??(bl.exactSku?{skuId:bl.exactSku.id,skuCode:bl.exactSku.code,skuName:bl.exactSku.name}:bl.approvedSkus[0]?{skuId:bl.approvedSkus[0].sku.id,skuCode:bl.approvedSkus[0].sku.code,skuName:bl.approvedSkus[0].sku.name}:null);
      const required=(override?.quantity??bl.quantity)*line.quantity;
      if(!chosen){lineOk=false;messages.push(`No approved SKU for ${bl.role}`);components.push({role:bl.role,required,available:null});continue;}
      const stock=await availability(db,chosen.skuId,locationId);if(stock.available!==null&&stock.available<required){lineOk=false;messages.push(`Insufficient ${chosen.skuCode} for ${bl.role}`);}
      components.push({role:bl.role,skuId:chosen.skuId,skuCode:chosen.skuCode,skuName:chosen.skuName,required,...stock});
    }
    if(!lineOk)blocked=true;buildCount+=line.quantity;
    lines.push({title:line.name??line.title??'Shopify item',sku:line.sku,quantity:line.quantity,ok:lineOk,productName:mapping.product.name,bomVersion:bom.version,message:messages.join('; ')||undefined,components});
  }
  return{dryRun:true,orderNumber:order.name??String(order.order_number??order.id),status:blocked?'BLOCKED':'READY_FOR_PRODUCTION',buildCount,locationId:locationId??null,lines};
}
