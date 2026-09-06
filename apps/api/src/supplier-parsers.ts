import type { DraftLine } from './invoice-extract.js';
const money='([\\d,]+\\.\\d{2})';
const cents=(s:string)=>Math.round(Number(s.replace(/,/g,''))*100);
const months=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
function dateOf(s:string|undefined){
 if(!s)return null;const m=s.match(/^(\d{1,2})[./-]([A-Za-z]+|\d{1,2})[./-](\d{2}|\d{4})$/);if(!m)return null;
 const month=/^\d+$/.test(m[2])?+m[2]-1:months.indexOf(m[2].slice(0,3).toLowerCase()),year=m[3].length===2?2000+(+m[3]):+m[3];
 const d=new Date(Date.UTC(year,month,+m[1]));return month>=0&&month<12&&d.getUTCDate()===+m[1]&&d.getUTCMonth()===month?d:null;
}
function value(t:string,re:RegExp){const m=t.match(re);return m?cents(m[1]):null;}
function checked(name:string,invoiceNumber:string|undefined,invoiceDate:Date|null,lines:DraftLine[],subtotal:number|null,freight:number|null,tax:number|null,total:number|null,dueDate:Date|null=null){
 if(!invoiceNumber||!invoiceDate||!lines.length||[subtotal,freight,tax,total].some(x=>x===null||!Number.isSafeInteger(x)||x<0))return null;
 if(lines.some(l=>!l.description||!l.supplierCode||!l.quantity||!Number.isInteger(l.quantity)||l.quantity>100000||l.unitCost===null||l.lineTotal===null||Math.abs(Math.round(l.unitCost*100)*l.quantity-Math.round(l.lineTotal*100))>1))return null;
 if(Math.abs(lines.reduce((n,l)=>n+Math.round(l.lineTotal!*100),0)-subtotal!)>1||Math.abs(subtotal!+freight!+tax!-total!)>1||Math.abs(Math.round((subtotal!+freight!)*0.15)-tax!)>1)return null;
 return {invoiceNumber,invoiceDate,dueDate,lines,subtotal:subtotal!/100,freight:freight!/100,tax:tax!/100,total:total!/100,warnings:[`${name} layout detected and amounts reconciled. Verify the original and confirm each SKU before approval.`]};
}
function dove(t:string){
 const lines:DraftLine[]=[];let freight=0;
 for(const row of t.split('\n')){
  const m=row.match(new RegExp('^[A-Z]{2} ([A-Z0-9-]+) (.+?) (\\d+) '+money+' '+money+'\\t(\\d+)(?:\\t(.+))?$'));
  if(!m)continue;const quantity=+m[6],unit=cents(m[4]),net=cents(m[5]);if(Math.abs(quantity*unit-net)>1)return null;
  if(m[1]==='FREIGHT')freight+=net;
  else lines.push({supplierCode:m[1],description:m[2]+(m[7]?` (MPN: ${m[7]})`:''),quantity,unitCost:unit/100,lineTotal:net/100});
 }
 const totals=t.match(new RegExp('SUBTOTAL: '+money+'\\s+'+money+'\\s+'+money+'\\s+INVOICE TOTAL:'));
 if(!totals)return null;
 return checked('Dove',t.match(/INV#\s+(\d+)/)?.[1],dateOf(t.match(/(?:^|\n)(\d{1,2}\.[A-Za-z]+\.\d{2})(?:\n|$)/)?.[1]),lines,cents(totals[1])-freight,freight,cents(totals[3]),cents(totals[2]));
}
function synnex(t:string){
 const numbers=[...new Set(t.match(/\bV\d{9}\b/g)??[])];if(numbers.length!==1)return null;
 // The serial-list page contains quantities again; it must never become invoice lines.
 const first=t.split(/-- 1 of \d+ --/)[0];
 const section=first.split('NO BRAND ITEM DESCRIPTION W/H UNIT QTY PRICE AMOUNT')[1];if(!section)return null;
 const lines:DraftLine[]=[];
 const re=new RegExp('^(.+?) ([A-Z]{3}\\d+-[A-Z]) PC (\\d+) '+money+' '+money+'$','gm');let m:RegExpExecArray|null;
 while((m=re.exec(section))){const after=section.slice(re.lastIndex).split('\n').slice(1);const desc:string[]=[];for(const r of after){if(/^\d+ [A-Z]|^FM Statement|^GOODS TOTAL/.test(r))break;if(r.trim())desc.push(r.trim());}lines.push({supplierCode:m[1],description:desc.join(' ')||m[1],quantity:+m[3],unitCost:cents(m[4])/100,lineTotal:cents(m[5])/100});}
 // Accept only the known no-discount/no-admin-charge layout, with exactly five printed totals.
 const totals=section.match(new RegExp('FM Statement \\d+ DAYS '+money+'\\s+'+money+'\\s+'+money+'\\s+'+money+'\\s+'+money+'\\s+GOODS TOTAL\\s+GOODS DISCOUNT\\s+NET AMOUNT\\s+FREIGHT CHARGE\\s+ADMIN CHARGE\\s+PLUS GST\\s+INVOICE TOTAL'));
 if(!totals||cents(totals[1])+cents(totals[3])!==cents(totals[2]))return null;
 return checked('Synnex',numbers[0],dateOf(first.match(/(\d{2}-[A-Za-z]{3}-\d{2}) NZD/)?.[1]),lines,cents(totals[1]),cents(totals[3]),cents(totals[4]),cents(totals[5]));
}
function ingram(t:string){
 const lines:DraftLine[]=[];const section=t.split('Code Description Ord Ship B/O Unit Extended')[1]?.split('TAX INVOICE')[0];if(!section)return null;
 const re=new RegExp('^(\\d{5,10}) ([^\\n]+)\\n([\\s\\S]*?)^(\\d+) (\\d+)(?: (\\d+))? '+money+' NZD '+money+' NZD$','gm');let m:RegExpExecArray|null;
 while((m=re.exec(section))){const vendor=m[3].match(/Vendor Part No ([^\n]+)/)?.[1];lines.push({supplierCode:m[1],description:m[2]+(vendor?` (MPN: ${vendor})`:''),quantity:+m[5],unitCost:cents(m[7])/100,lineTotal:cents(m[8])/100});}
 const subtotal=value(t,new RegExp('Ext Total '+money)),freight=value(t,new RegExp('(?:^|\\n)Freight '+money)),net=value(t,new RegExp('Sub Total '+money));if(subtotal===null||freight===null||net!==subtotal+freight)return null;
 return checked('Ingram',t.match(/TAX INVOICE\s+(\d+)/)?.[1],dateOf(t.match(/Date Invoiced\s*:\s*([\d.]+)/)?.[1]),lines,subtotal,freight,value(t,new RegExp('(?:^|\\n)GST '+money)),value(t,new RegExp('Invoice Total '+money)));
}
function roctech(t:string){
 const ids=[...new Set([...t.matchAll(/Invoice Number: (\S+)/g)].map(m=>m[1]))];if(ids.length!==1)return null;
 const section=t.split('Item Quantity Rate Amount NZD')[1]?.split(/-- 1 of \d+ --/)[0];if(!section)return null;
 const rows=section.trim().split('\n'),lines:DraftLine[]=[];let code:string|null=null,desc:string[]=[];
 for(const [index,r] of rows.entries()){
  if(!code){if(/^[A-Z][A-Z0-9-]{3,}$/.test(r.trim())&&/[a-z]/.test(rows[index+1]??'')){code=r.trim();desc=[];}continue;}
  const m=r.match(new RegExp('^(.*?)\\s*(\\d+) \\$'+money+' \\$'+money+'$'));
  if(m){if(m[1].trim())desc.push(m[1].trim());lines.push({supplierCode:code,description:desc.join(' '),quantity:+m[2],unitCost:cents(m[3])/100,lineTotal:cents(m[4])/100});code=null;desc=[];}
  else desc.push(r.trim());
 }
 if(code)return null;
 return checked('ExtremePC/RocTech',ids[0],dateOf(t.match(/(?:^|\n)Date: ([\d/]+)/)?.[1]),lines,value(t,new RegExp('Subtotal NZD \\$'+money)),value(t,new RegExp('Shipping Cost \\$'+money)),value(t,new RegExp('GST Total \\$'+money)),value(t,new RegExp('(?:^|\\n)Total NZD \\$'+money)),dateOf(t.match(/20th of the Month ([\d/]+)/)?.[1]));
}
export function extractSupplierInvoice(text:string){
 const t=text.replace(/\r/g,'');
 const parser=/Dove Electronics Ltd\./.test(t)?dove:/SYNNEX NEW ZEALAND LTD/.test(t)?synnex:/Ingram Micro \(NZ\) Limited/.test(t)?ingram:/Roc tech Limited Trade as ExtremePC/.test(t)?roctech:null;
 if(!parser)return null;
 // Reject credit documents and ambiguous/changed layouts rather than falling through to loose row guesses.
 const p=/\bCREDIT NOTE\b/i.test(t)?null:parser(t);if(p)return p;
 return {invoiceNumber:null,invoiceDate:null,dueDate:null,subtotal:null,freight:null,tax:null,total:null,lines:[] as DraftLine[],warnings:['Supplier recognised, but this document layout or its totals could not be validated. Enter the draft from the original; do not assume extracted amounts are complete.']};
}
