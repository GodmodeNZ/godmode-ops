import { Prisma } from '@prisma/client';
import { ensure, DomainError } from './core.js';

export const D = (n: any) => new Prisma.Decimal(n);
export const money = (n: any) => D(n).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
export const day = (d: any) => new Date(d).toISOString().slice(0, 10);
export const allocationKinds = ['freight', 'importCharges', 'paymentFees'] as const;
export function documentCurrency(text:string, declared?:string) {
  if(declared&&/^[A-Z]{3}$/.test(declared))return declared;
  const explicit=text.match(/(?:invoice\s+currency|currency)\s*[:=]\s*([A-Z]{3})\b/);
  if(explicit)return explicit[1];
  const codes=[...new Set(text.match(/\b(?:NZD|AUD|USD|EUR|GBP|CAD|JPY|CNY|HKD|SGD|CHF|INR)\b/g)??[])];
  if(codes.length===1)return codes[0];
  if(codes.length>1)return 'XXX';
  if(/US\$/.test(text))return 'USD';if(/A\$|AU\$/.test(text))return 'AUD';if(/NZ\$/.test(text))return 'NZD';
  return 'XXX';
}
export function localRate(date: any) {
  return { fxRate: D(1), fxRequestedDate: date ? new Date(day(date)) : null, fxDate: date ? new Date(day(date)) : null, fxSource: 'NZD base currency', fxManual: false, fxConfirmed: true, fxConfirmedBy: 'system', fxNeedsReview: false };
}
export function rateIssues(r: any, date: any): string[] {
  if (r.currency === 'NZD') return [];
  const issues: string[] = [];
  if(r.currency==='XXX')issues.push('Choose the original invoice currency; it could not be determined reliably');
  if (!r.fxRate || !D(r.fxRate).isFinite() || D(r.fxRate).lte(0)) issues.push('Enter a positive exchange rate: 1 '+r.currency+' = X NZD');
  if (!r.fxDate || !r.fxRequestedDate || !date || day(r.fxRequestedDate) !== day(date)) issues.push('Look up or enter a rate for the invoice/order date');
  if (r.fxDate && date && day(r.fxDate) > day(date)) issues.push('Rate effective date cannot be after the invoice/order date');
  if (!r.fxSource?.trim()) issues.push('Record the exchange-rate source');
  if (!r.fxConfirmed || r.fxNeedsReview) issues.push('Confirm the exchange rate before approval or ordering');
  return issues;
}

// Allocate integer cents with a deterministic largest-remainder rule. Never round
// every unit independently: receipt splits must sum back to the approved value.
export function allocate(total: any, weights: any[]): Prisma.Decimal[] {
  const cents = money(total).mul(100); const w = weights.map(D); const sum = w.reduce((a,b)=>a.add(b),D(0));
  ensure(cents.gte(0) && w.every(x=>x.gte(0)), 'Allocation amounts must be non-negative',400);
  if (cents.eq(0)) return w.map(()=>D(0));
  ensure(sum.gt(0), 'Cannot allocate a charge across zero-value/zero-quantity lines',400);
  const shares = w.map((x,i)=>({i, exact:cents.mul(x).div(sum), cents:cents.mul(x).div(sum).floor()}));
  let remaining = cents.sub(shares.reduce((s,x)=>s.add(x.cents),D(0))).toNumber();
  const ranked = [...shares].sort((a,b)=>b.exact.sub(b.cents).cmp(a.exact.sub(a.cents))||a.i-b.i);
  for(let i=0;i<remaining;i++) ranked[i].cents=ranked[i].cents.add(1);
  return shares.map(x=>x.cents.div(100));
}
export function receiptValue(total: any, quantity: number, alreadyReceived: number, receiving: number) {
  ensure(quantity>0 && receiving>0 && alreadyReceived>=0 && alreadyReceived+receiving<=quantity,'Invalid partial receipt',400);
  return money(D(total).mul(alreadyReceived+receiving).div(quantity)).sub(money(D(total).mul(alreadyReceived).div(quantity)));
}
export function snapshot(r: any, lines: any[], date: any, confirmed=true): any {
  if (confirmed) ensure(!rateIssues(r,date).length,rateIssues(r,date).join('; '),400);
  const rate = r.currency==='NZD'?D(1):(r.fxRate?D(r.fxRate):null);
  ensure(rate && rate.isFinite() && rate.gt(0),'No valid rate is available; foreign amounts are not NZD',400);
  ensure(lines.length && lines.every(l=>l.quantity>0 && l.unitCost!=null && l.lineTotal!=null),'Complete product quantities and original prices first',400);
  const amounts=lines.map(l=>money(l.lineTotal));
  const goods=allocate(money(amounts.reduce((s,n)=>s.add(n),D(0)).mul(rate)),amounts);
  const allocated=lines.map(()=>D(0));const charges: any = {};
  for(const kind of allocationKinds){
    const amount=r[kind];ensure(amount!=null,'Enter '+kind+' (0 if applicable)',400);
    const nzd=money(D(amount).mul(rate));const choice=r.costAllocation?.[kind];
    ensure(D(amount).gte(0),'Charges must be non-negative',400);
    ensure(D(amount).eq(0)||choice?.method,'Choose explicitly whether '+kind+' is expensed or allocated to stock',400);
    const method=choice?.method??'EXPENSE';let shares=lines.map(()=>D(0));
    if(method==='VALUE')shares=allocate(nzd,amounts);
    else if(method==='QUANTITY')shares=allocate(nzd,lines.map(l=>l.quantity));
    else if(method==='MANUAL'){
      ensure(Array.isArray(choice.amounts)&&choice.amounts.length===lines.length,'Enter one original-currency allocation per line for '+kind,400);
      const manual=choice.amounts.map((n:any)=>money(n));
      ensure(manual.every((n:any)=>n.gte(0))&&manual.reduce((s:any,n:any)=>s.add(n),D(0)).eq(money(amount)),'Manual allocations must equal the '+kind+' amount',400);
      shares=allocate(nzd,manual);
    } else ensure(method==='EXPENSE','Invalid allocation method',400);
    shares.forEach((n,i)=>allocated[i]=allocated[i].add(n));
    charges[kind]={original:money(amount).toFixed(2),nzd:nzd.toFixed(2),method,allocationsNzd:shares.map(n=>n.toFixed(2))};
  }
  const convert=(n:any)=>n==null?null:money(D(n).mul(rate)).toFixed(2);
  return {baseCurrency:'NZD',originalCurrency:r.currency,direction:'1 '+r.currency+' = '+rate.toFixed()+' NZD',rate:rate.toFixed(),requestedDate:date?day(date):null,effectiveDate:r.currency==='NZD'?(date?day(date):null):(r.fxDate?day(r.fxDate):null),source:r.currency==='NZD'?'NZD base currency':r.fxSource,manual:Boolean(r.fxManual),subtotalNzd:goods.reduce((s,n)=>s.add(n),D(0)).toFixed(2),taxNzd:convert(r.tax),totalNzd:convert(r.total),charges,stockValueNzd:goods.reduce((s,n,i)=>s.add(n).add(allocated[i]),D(0)).toFixed(2),lines:lines.map((l,i)=>({position:i,quantity:l.quantity,originalUnitCost:money(l.unitCost).toFixed(2),originalLineTotal:amounts[i].toFixed(2),unitCostNzd:D(l.unitCost).mul(rate).toDecimalPlaces(8).toFixed(),lineTotalNzd:goods[i].toFixed(2),allocatedChargesNzd:allocated[i].toFixed(2),stockValueNzd:goods[i].add(allocated[i]).toFixed(2),stockUnitCostNzd:goods[i].add(allocated[i]).div(l.quantity).toDecimalPlaces(8).toFixed()}))};
}
export function fxView(r:any, lines:any[], date:any) {
  let preview=null,previewError=null;
  try{preview=r.nzdSnapshot??snapshot(r,lines,date,false);}catch(e){previewError=(e as Error).message;}
  return { ...r, fxIssues:rateIssues(r,date), nzd:preview, nzdPreviewError:previewError, baseCurrency:'NZD' };
}
export async function historicalRate(currency: string, date: string) {
  ensure(/^[A-Z]{3}$/.test(currency)&&/^\d{4}-\d{2}-\d{2}$/.test(date)&&day(date)===date,'Invalid currency or date',400);
  ensure(date<=new Date().toISOString().slice(0,10),'Historical lookup is unavailable for a future date',400);
  if(currency==='NZD')return localRate(date);
  const url=`https://api.frankfurter.dev/v1/${date}?base=${currency}&symbols=NZD`;
  let body:any;
  try{const response=await fetch(url,{signal:AbortSignal.timeout(12000)});ensure(response.ok,'Historical rate unavailable; enter a documented manual rate',400);body=await response.json();}
  catch{throw new DomainError('Historical rate service unavailable. Enter a manual rate, its effective date and source. No rate was substituted.',400);}
  ensure(body.base===currency&&typeof body.date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(body.date)&&day(body.date)===body.date&&body.date<=date,'Provider returned an unexpected currency or effective date',400);
  ensure(new Date(date).getTime()-new Date(body.date).getTime()<=7*86400000,'Provider rate is more than seven days older than the invoice; review manually',400);
  const rate=D(body.rates?.NZD??0);ensure(rate.isFinite()&&rate.gt(0),'Provider did not return a positive NZD rate',400);
  return {fxRate:rate,fxRequestedDate:new Date(date),fxDate:new Date(body.date),fxSource:'Frankfurter v1 / ECB reference rate; '+url,fxManual:false,fxConfirmed:false,fxConfirmedBy:null,fxNeedsReview:true};
}
