import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actor, ensure, mutate } from './core.js';
import { D, day, historicalRate, localRate, rateIssues } from './fx.js';

export async function registerFx(app:FastifyInstance,db:PrismaClient){
  app.patch('/purchase-orders/:id/costing',async q=>{
    const choice=z.object({method:z.enum(['EXPENSE','VALUE','QUANTITY','MANUAL']),amounts:z.array(z.number().finite().nonnegative()).optional()});
    const b=z.object({version:z.number().int(),currency:z.string().regex(/^[A-Z]{3}$/),orderDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),freight:z.number().finite().nonnegative(),tax:z.number().finite().nonnegative(),importCharges:z.number().finite().nonnegative(),paymentFees:z.number().finite().nonnegative(),costAllocation:z.object({freight:choice.optional(),importCharges:choice.optional(),paymentFees:choice.optional()})}).parse(q.body);
    ensure(day(b.orderDate)===b.orderDate,'Invalid order date',400);
    return mutate(db,q,'Review original-currency PO charges and allocation',async tx=>{
      const p=await tx.purchaseOrder.findUniqueOrThrow({where:{id:(q.params as any).id},include:{lines:true}});
      ensure(p.version===b.version&&!p.fxLockedAt&&p.lines.every(l=>l.quantityReceived===0)&&['DRAFT','ORDERED'].includes(p.status),'PO costs are locked or changed; reopen before editing',409);
      const changed=p.currency!==b.currency||day(p.orderDate)!==b.orderDate;
      const fx=b.currency==='NZD'?localRate(b.orderDate):changed?{fxRate:null,fxDate:null,fxRequestedDate:null,fxSource:null,fxConfirmed:false,fxConfirmedBy:null,fxNeedsReview:true}:{};
      const {version,...fields}=b;
      return tx.purchaseOrder.update({where:{id:p.id},data:{...fields,...fx,orderDate:new Date(b.orderDate),total:null,version:{increment:1}}});
    });
  });
  for(const kind of ['invoices','purchase-orders'] as const){
    const invoice=kind==='invoices';
    const get=async(client:any,id:string)=>invoice?client.supplierInvoice.findUniqueOrThrow({where:{id},include:{lines:true}}):client.purchaseOrder.findUniqueOrThrow({where:{id},include:{lines:true}});
    const update=async(client:any,id:string,data:any)=>invoice?client.supplierInvoice.update({where:{id},data}):client.purchaseOrder.update({where:{id},data});
    const date=(r:any)=>invoice?r.invoiceDate:r.orderDate;
    const editable=(r:any,version:number)=>{ensure(r.version===version,'The record changed. Reopen it before editing the rate.',409);ensure(!r.fxLockedAt&&(invoice?r.status==='REVIEW':['DRAFT','ORDERED'].includes(r.status)&&r.lines.every((l:any)=>l.quantityReceived===0)),'This rate is locked; approved or received costs cannot be changed',409);};
    app.post(`/${kind}/:id/fx/lookup`,async q=>{
      const {version}=z.object({version:z.number().int()}).parse(q.body),id=(q.params as any).id;
      const old=await get(db,id);editable(old,version);ensure(date(old),'Enter the invoice/order date first',400);
      const result=await historicalRate(old.currency,day(date(old)));
      return mutate(db,q,'Look up historical NZD exchange rate',async tx=>{const r=await get(tx,id);editable(r,version);ensure(r.currency===old.currency&&day(date(r))===day(date(old)),'Invoice date or currency changed',409);return update(tx,id,{...result,version:{increment:1}});});
    });
    app.patch(`/${kind}/:id/fx`,async q=>{
      const b=z.object({version:z.number().int(),mode:z.enum(['MANUAL','CONFIRM']),rate:z.string().regex(/^\d+(\.\d{1,10})?$/).optional(),effectiveDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),source:z.string().trim().min(3).max(1000).optional(),confirmed:z.boolean()}).parse(q.body),id=(q.params as any).id;
      return mutate(db,q,'Review NZD exchange rate',async tx=>{
        const r=await get(tx,id);editable(r,b.version);ensure(date(r),'Enter the invoice/order date first',400);
        let data:any;
        if(r.currency==='NZD')data=localRate(date(r));
        else if(b.mode==='MANUAL'){
          ensure(b.rate&&D(b.rate).gt(0)&&D(b.rate).lt(1000000)&&b.effectiveDate&&day(b.effectiveDate)===b.effectiveDate&&b.source,'Enter a positive rate, effective date and source',400);
          data={fxRate:D(b.rate!),fxRequestedDate:new Date(day(date(r))),fxDate:new Date(b.effectiveDate!),fxSource:'Manual override: '+b.source,fxManual:true,fxConfirmed:b.confirmed,fxConfirmedBy:b.confirmed?actor(q):null,fxNeedsReview:!b.confirmed};
        }else data={fxConfirmed:b.confirmed,fxConfirmedBy:b.confirmed?actor(q):null,fxNeedsReview:!b.confirmed};
        ensure(!rateIssues({...r,...data,fxConfirmed:true,fxNeedsReview:false},date(r)).length,rateIssues({...r,...data,fxConfirmed:true,fxNeedsReview:false},date(r)).join('; '),400);
        return update(tx,id,{...data,version:{increment:1}});
      });
    });
  }
  app.post('/invoices/:id/payments',async q=>{
    const b=z.object({amountNzd:z.number().finite().positive().max(999999999).multipleOf(.01),paidAt:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),reference:z.string().trim().min(1).max(500)}).parse(q.body);
    ensure(day(b.paidAt)===b.paidAt,'Invalid payment date',400);
    return mutate(db,q,'Record actual NZD payment separately from invoice conversion',async tx=>{
      await tx.supplierInvoice.findUniqueOrThrow({where:{id:(q.params as any).id}});
      return tx.invoicePayment.create({data:{invoiceId:(q.params as any).id,amountNzd:D(b.amountNzd),paidAt:new Date(b.paidAt),reference:b.reference,recordedBy:actor(q)}});
    });
  });
}
