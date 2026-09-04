import { createHmac, timingSafeEqual } from 'node:crypto';
import { Prisma, PrismaClient, TrackingMode, ReservationStatus, SalesOrderStatus, SalesOrderLineStatus } from '@prisma/client';

export type ShopifyLine = { id:number|string; product_id?:number|string|null; variant_id?:number|string|null; sku?:string|null; title?:string; name?:string; quantity:number; properties?:Array<{name:string;value:string}> };
export type ShopifyOrder = { id:number|string; name?:string; order_number?:number|string; financial_status?:string|null; fulfillment_status?:string|null; currency?:string; total_price?:string; created_at?:string; customer?:{first_name?:string;last_name?:string;email?:string}; email?:string; line_items?:ShopifyLine[] };

export function verifyShopifyHmac(rawBody: Buffer, header: string | undefined, secret: string) {
  if (!header || !secret) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('base64');
  const a = Buffer.from(expected); const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a,b);
}

const propMap=(properties?:ShopifyLine['properties'])=>Object.fromEntries((properties??[]).filter(p=>p.name).map(p=>[p.name,String(p.value??'')]));
const idString=(v:unknown)=>v===null||v===undefined?undefined:String(v);

export async function upsertShopifyOrder(db:PrismaClient, payload:ShopifyOrder, shopDomain?:string) {
  const externalId=String(payload.id); const orderNumber=payload.name??String(payload.order_number??payload.id);
  return db.salesOrder.upsert({where:{source_externalId:{source:'SHOPIFY',externalId}},create:{source:'SHOPIFY',externalId,orderNumber,shopDomain,financialStatus:payload.financial_status??undefined,fulfillmentStatus:payload.fulfillment_status??undefined,currency:payload.currency,total:payload.total_price?new Prisma.Decimal(payload.total_price):undefined,customerName:[payload.customer?.first_name,payload.customer?.last_name].filter(Boolean).join(' ')||undefined,customerEmail:payload.email??payload.customer?.email,externalCreatedAt:payload.created_at?new Date(payload.created_at):undefined,raw:payload as Prisma.InputJsonValue,lines:{create:(payload.line_items??[]).map(line=>({externalLineId:String(line.id),title:line.name??line.title??'Shopify item',sku:line.sku||undefined,shopifyProductId:idString(line.product_id),shopifyVariantId:idString(line.variant_id),quantity:line.quantity,properties:propMap(line.properties)}))}},update:{orderNumber,shopDomain,financialStatus:payload.financial_status??undefined,fulfillmentStatus:payload.fulfillment_status??undefined,currency:payload.currency,total:payload.total_price?new Prisma.Decimal(payload.total_price):undefined,raw:payload as Prisma.InputJsonValue},include:{lines:true}});
}

async function findMapping(db:PrismaClient,line:{shopifyVariantId:string|null;shopifyProductId:string|null;sku:string|null},shopDomain:string|null){
  const ors:Prisma.ShopifyProductMappingWhereInput[]=[];
  if(line.shopifyVariantId)ors.push({shopifyVariantId:line.shopifyVariantId});
  if(line.shopifyProductId)ors.push({shopifyProductId:line.shopifyProductId,shopifyVariantId:null});
  if(line.sku)ors.push({sku:line.sku,shopifyVariantId:null,shopifyProductId:null});
  if(!ors.length)return null;
  return db.shopifyProductMapping.findFirst({where:{active:true,OR:ors,AND:[{OR:[{shopDomain},{shopDomain:null}]}]},orderBy:{priority:'asc'},include:{product:true,configurationRules:true}});
}

async function reserveBuild(tx:Prisma.TransactionClient,buildId:string,locationId:string){
  const build=await tx.build.findUniqueOrThrow({where:{id:buildId},include:{lines:true}});
  for(const line of build.lines){
    if(!line.allocatedSkuId)throw Error(`No approved SKU for ${line.role}`);
    const sku=await tx.sku.findUniqueOrThrow({where:{id:line.allocatedSkuId}});
    if(sku.trackingMode===TrackingMode.SERIALIZED){
      const units=await tx.inventoryUnit.findMany({where:{skuId:sku.id,locationId,consumedAt:null,reservations:{none:{status:ReservationStatus.ACTIVE}}},orderBy:{receivedAt:'asc'},take:line.quantity});
      if(units.length<line.quantity)throw Error(`Insufficient ${sku.code} for ${line.role}`);
      for(const unit of units)await tx.inventoryReservation.create({data:{skuId:sku.id,locationId,buildId,buildLineId:line.id,inventoryUnitId:unit.id,quantity:1}});
    }else{
      const onHand=(await tx.inventoryTransaction.aggregate({where:{skuId:sku.id,locationId},_sum:{quantityDelta:true}}))._sum.quantityDelta??0;
      const reserved=(await tx.inventoryReservation.aggregate({where:{skuId:sku.id,locationId,status:ReservationStatus.ACTIVE},_sum:{quantity:true}}))._sum.quantity??0;
      if(onHand-reserved<line.quantity)throw Error(`Insufficient ${sku.code} for ${line.role}`);
      await tx.inventoryReservation.create({data:{skuId:sku.id,locationId,buildId,buildLineId:line.id,quantity:line.quantity}});
    }
  }
  return tx.build.update({where:{id:buildId},data:{status:'RESERVED',events:{create:{type:'INVENTORY_RESERVED',actor:'shopify'}}}});
}

export async function resolveSalesOrder(db:PrismaClient,salesOrderId:string,locationId?:string){
  const order=await db.salesOrder.findUniqueOrThrow({where:{id:salesOrderId},include:{lines:true}}); let blocked=false;
  for(const line of order.lines){
    if(line.buildIds.length)continue;
    const mapping=await findMapping(db,line,order.shopDomain);
    if(!mapping){blocked=true;await db.salesOrderLine.update({where:{id:line.id},data:{status:SalesOrderLineStatus.BLOCKED,resolutionMessage:'No Shopify product mapping'}});continue;}
    const bom=await db.bomVersion.findFirst({where:{productId:mapping.productId,active:true},orderBy:{version:'desc'},include:{lines:{include:{approvedSkus:{orderBy:{priority:'asc'}}}}}});
    if(!bom){blocked=true;await db.salesOrderLine.update({where:{id:line.id},data:{status:SalesOrderLineStatus.BLOCKED,mappingId:mapping.id,resolvedProductId:mapping.productId,resolutionMessage:'Mapped product has no active BOM'}});continue;}
    const properties=(line.properties??{}) as Record<string,unknown>;
    const overrides=new Map<string,{skuId:string;quantity?:number}>();
    for(const rule of mapping.configurationRules){
      const actual=rule.propertyName==='__variant_id__'?line.shopifyVariantId:rule.propertyName==='__sku__'?line.sku:String(properties[rule.propertyName]??'');
      if(String(actual??'')===rule.propertyValue)overrides.set(rule.role,{skuId:rule.replacementSkuId,quantity:rule.quantity??undefined});
    }
    const buildIds:string[]=[];
    for(let unitIndex=0;unitIndex<line.quantity;unitIndex++){
      const buildNumber=`${order.orderNumber.replace(/[^A-Za-z0-9-]/g,'')}-${line.id.slice(-6)}-${unitIndex+1}`;
      const build=await db.build.create({data:{buildNumber,productId:mapping.productId,bomVersionId:bom.id,externalOrderId:order.externalId,lines:{create:bom.lines.map(bl=>{const o=overrides.get(bl.role);return{role:bl.role,quantity:o?.quantity??bl.quantity,requestedSkuId:o?.skuId??bl.exactSkuId,requirement:bl.requirement,allocatedSkuId:o?.skuId??bl.exactSkuId??bl.approvedSkus[0]?.skuId}})},events:{create:{type:'BUILD_CREATED_FROM_SHOPIFY',metadata:{salesOrderId:order.id,salesOrderLineId:line.id,shopifyVariantId:line.shopifyVariantId}}}},include:{lines:true}});
      buildIds.push(build.id);
      if(locationId){try{await db.$transaction(tx=>reserveBuild(tx,build.id,locationId));}catch(e){blocked=true;await db.buildEvent.create({data:{buildId:build.id,type:'INVENTORY_RESERVATION_BLOCKED',actor:'shopify',metadata:{message:e instanceof Error?e.message:String(e)}}});}}
    }
    await db.salesOrderLine.update({where:{id:line.id},data:{status:SalesOrderLineStatus.RESOLVED,mappingId:mapping.id,resolvedProductId:mapping.productId,buildIds,resolutionMessage:null}});
  }
  const refreshed=await db.salesOrder.findUniqueOrThrow({where:{id:salesOrderId},include:{lines:true}}); const unresolved=refreshed.lines.some(l=>l.status!==SalesOrderLineStatus.RESOLVED);
  return db.salesOrder.update({where:{id:salesOrderId},data:{status:blocked||unresolved?SalesOrderStatus.BLOCKED:SalesOrderStatus.READY_FOR_PRODUCTION},include:{lines:true}});
}
