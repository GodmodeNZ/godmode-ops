import {PrismaClient} from '@prisma/client';
import {averageCost,valuationNeedsReview} from './core.js';
import {D,money} from './fx.js';
import {purchasePlan} from './procurement.js';
export async function costReports(db:PrismaClient){
 const [skus,units,orders,plan,products]=await Promise.all([db.sku.findMany(),db.godmodeUnit.findMany({include:{components:true,shipment:true,build:{include:{product:true}}}}),db.salesOrder.findMany({include:{lines:true}}),purchasePlan(db),db.product.findMany({include:{bomVersions:{where:{active:true},orderBy:{version:'desc'},take:1,include:{lines:{include:{approvedSkus:{orderBy:{priority:'asc'}}}}}}}})]);
 const stock=await db.inventoryTransaction.groupBy({by:['skuId'],_sum:{quantityDelta:true}});
 const valuation=await Promise.all(skus.map(async sku=>{
  const qty=stock.find(x=>x.skuId===sku.id)?._sum.quantityDelta??0;
  const risk=await valuationNeedsReview(db,sku.id),missing=(await db.inventoryTransaction.count({where:{skuId:sku.id,quantityDelta:{gt:0},unitCost:null,valueDeltaNzd:null}}))>0;
  const cost=risk||missing?null:await averageCost(db,sku.id);
  return {skuId:sku.id,sku:sku.name,code:sku.code,quantity:qty,averageCost:cost,value:cost===null?null:money(cost.mul(qty)),needsReview:risk||missing,currency:'NZD'};
 }));
 const buildCosts=units.map(u=>{
  const missing=!u.components.length||u.components.some(c=>(c.nzdUnitCost==null&&c.unitCost==null)||valuation.find(v=>v.skuId===c.skuId)?.needsReview);
  return {buildId:u.buildId,unitNumber:u.unitNumber,product:u.build.product.name,dispatched:Boolean(u.shipment),cost:missing?null:money(u.components.reduce((s,c)=>s.add(c.nzdLineTotal??D(c.nzdUnitCost??c.unitCost!).mul(c.quantity)),D(0))).toNumber(),currency:'NZD',needsReview:missing};
 });
 const bomCosts=products.map(p=>{
  const bom=p.bomVersions[0];const lines=bom?.lines.map(l=>{const skuId=l.exactSkuId??l.approvedSkus[0]?.skuId;const v=valuation.find(v=>v.skuId===skuId);return {role:l.role,quantity:l.quantity,skuId,unitCostNzd:v?.quantity&&v.averageCost!=null?String(v.averageCost):null};})??[];
  return {product:p.name,version:bom?.version??null,currency:'NZD',cost:!lines.length||lines.some(l=>l.unitCostNzd===null)?null:money(lines.reduce((s,l)=>s.add(D(l.unitCostNzd!).mul(l.quantity)),D(0))).toNumber(),lines};
 });
 const margins=orders.map(o=>{
  const ids=o.lines.flatMap(l=>l.buildIds),costs=ids.map(id=>buildCosts.find(b=>b.buildId===id));
  const raw=o.raw as any,tax=raw?.total_tax;
  const complete=ids.length>0&&o.lines.every(l=>l.status==='RESOLVED'&&l.buildIds.length===l.quantity)&&costs.every(c=>c&&c.cost!==null);
  const revenue=o.currency==='NZD'&&o.total!=null&&tax!=null&&/^\d+(\.\d+)?$/.test(String(tax))?money(D(o.total).sub(tax)):null;
  const cost=complete?money(costs.reduce((s,c)=>s.add(c!.cost!),D(0))):null;
  const margin=revenue&&cost?money(revenue.sub(cost)):null;
  return {order:o.orderNumber,currency:'NZD',revenueExTaxNzd:revenue,costNzd:cost,marginNzd:margin,marginPercent:margin&&revenue?.gt(0)?margin.div(revenue).mul(100).toDecimalPlaces(2):null,needsReview:margin===null,note:margin===null?'Needs NZD sales revenue, explicit sales tax and complete build costs':'Component margin including allocated landed costs; excludes labour and overhead'};
 });
 const sum=(items:any[])=>items.some(x=>x==null)?null:money(items.reduce((s,x)=>s.add(x),D(0))).toNumber();
 return {baseCurrency:'NZD',valuation,inventoryValue:sum(valuation.filter(v=>v.quantity!==0).map(v=>v.value)),finishedGoodsValue:sum(units.filter(u=>!u.shipment).map(u=>buildCosts.find(b=>b.buildId===u.buildId)!.cost)),buildCosts,bomCosts,margins,openOrderValue:sum(orders.filter(o=>!['COMPLETED','CANCELLED'].includes(o.status)).map(o=>o.currency==='NZD'?o.total:null)),shortageLines:plan.filter(p=>p.shortage>0).length,foreignInvoicesNeedingReview:await db.supplierInvoice.count({where:{currency:{not:'NZD'},fxNeedsReview:true}}),foreignPurchaseOrdersNeedingReview:await db.purchaseOrder.count({where:{currency:{not:'NZD'},fxNeedsReview:true}})};
}
