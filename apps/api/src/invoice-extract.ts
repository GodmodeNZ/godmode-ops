import { simpleParser } from 'mailparser';
import { parse } from 'csv-parse/sync';
import { ensure } from './core.js';
export type DraftLine = { description: string; supplierCode?: string; barcode?: string; quantity: number | null; unitCost: number | null; lineTotal: number | null };
const amount = (s: any) => { if (s==null || !String(s).trim()) return null; const n=Number(String(s).replace(/[,$\s]/g,'')); return Number.isFinite(n)&&n>=0 ? n : null; };
export function extractText(text: string, csv = false) {
  const warnings = ['Verify the extracted quantities and costs against the original before approval. Unit costs must be excluding GST.'];
  const lines: DraftLine[] = [];
  if(csv) {
    const rows = parse<any>(text,{columns:(headers:string[])=>headers.map(h=>h.trim().toLowerCase().replace(/[ _-]/g,'')),skip_empty_lines:true,bom:true,trim:true});
    ensure(rows.length<=500,'Invoices can contain up to 500 lines',400);
    for(const r of rows) { const quantity=amount(r.quantity??r.qty),unitCost=amount(r.unitcost??r.unitprice??r.price); lines.push({description:r.description??r.name??r.product??'',supplierCode:r.suppliercode??r.sku??r.code,barcode:r.barcode,quantity:quantity&&Number.isInteger(quantity)?quantity:null,unitCost,lineTotal:amount(r.linetotal??r.amount??r.total)??(quantity!==null&&unitCost!==null?Math.round(quantity*unitCost*100)/100:null)}); }
  } else {
    // Deliberately conservative: only recognise rows ending in qty, unit cost, line total.
    // Other layouts remain editable drafts, never manufactured values.
    for(const row of text.split(/\r?\n/)) {
      if(/\b(subtotal|sub total|total|balance|gst|freight|shipping|discount|payment)\b/i.test(row)) continue;
      const m=row.match(/^(.+?)\s+(\d{1,5})\s+\$?([\d,]+\.\d{2})\s+\$?([\d,]+\.\d{2})\s*$/);
      if(m) lines.push({description:m[1].trim(),quantity:Number(m[2]),unitCost:amount(m[3]),lineTotal:amount(m[4])});
    }
  }
  if(!lines.length) warnings.push('No reliable item rows were detected. Add the invoice lines manually; this document has not been fully extracted. Scanned PDFs require manual entry.');
  const find=(re:RegExp)=>amount(text.match(re)?.[1]);
  const parseDate=(v:string|undefined)=>{ if(!v)return null; const iso=v.match(/^(\d{4})-(\d{2})-(\d{2})$/),nz=v.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/);const raw=iso?v:nz?`${nz[3]}-${nz[2].padStart(2,'0')}-${nz[1].padStart(2,'0')}`:null;return raw&&Number.isFinite(Date.parse(raw))?new Date(raw):null; };
  return {lines,warnings,invoiceNumber:text.match(/(?:invoice\s*(?:number|no\.?|#))\s*[:#]?\s*([A-Z0-9][A-Z0-9\-/]+)/i)?.[1]??null,invoiceDate:parseDate(text.match(/(?:invoice date|date issued)\s*:?\s*([\d./-]+)/i)?.[1]),dueDate:parseDate(text.match(/due date\s*:?\s*([\d./-]+)/i)?.[1]),subtotal:find(/(?:^|\n)\s*sub\s*total[^\d\n]*([\d,]+\.\d{2})/i),tax:find(/(?:^|\n)\s*(?:GST|tax)(?:\s*\(?15%\)?)?[^\d\n]*([\d,]+\.\d{2})/i),freight:find(/(?:^|\n)\s*(?:freight|shipping)[^\d\n]*([\d,]+\.\d{2})/i),total:find(/(?:^|\n)\s*(?:grand total|total due|total incl[^\n\d]*|total)[^\d\n]*([\d,]+\.\d{2})/i)};
}
export async function extractDocument(bytes: Buffer, filename: string): Promise<{text:string;parsed:ReturnType<typeof extractText>;sender?:string;subject?:string;sourceRef?:string;contentType:string}> {
  ensure(bytes.length>0&&bytes.length<=8*1024*1024,'Files must be between 1 byte and 8 MB',400);
  const ext=filename.toLowerCase().split('.').pop();let text='';let contentType='text/plain';let meta:any={};
  if(ext==='eml') {
    const mail=await simpleParser(bytes,{skipTextToHtml:true,skipImageLinks:true,maxHtmlLengthToParse:2*1024*1024});meta={sender:mail.from?.value[0]?.address,subject:mail.subject,sourceRef:mail.messageId};text=mail.text??'';contentType='message/rfc822';
    // One original email may contain several invoices. Preserve it for review rather than mixing totals.
    const docs=mail.attachments.filter(a=>/\.(pdf|csv|txt)$/i.test(a.filename??''));
    if(docs.length===1) { const inner=await extractDocument(docs[0].content,docs[0].filename!);return {...inner,...meta,contentType, text:inner.text}; }
    if(docs.length>1) { const parsed=extractText(''); parsed.warnings.push('This email has multiple invoice attachments. Import each attachment separately to keep totals separate.'); return {text:mail.text??'',parsed,...meta,contentType}; }
  } else if(ext==='pdf') {
    ensure(bytes.subarray(0,5).toString()==='%PDF-','This file is not a PDF',400); contentType='application/pdf';
    const {PDFParse}=await import('pdf-parse'); const parser=new PDFParse({data:new Uint8Array(bytes)});
    try { const result=await parser.getText();text=result.text; } finally {await parser.destroy();}
  } else if(ext==='csv') {contentType='text/csv';text=bytes.toString('utf8');}
  else {ensure(ext==='txt','Upload a PDF, CSV, TXT or saved EML email',400);text=bytes.toString('utf8');}
  return {text:text.slice(0,300000),parsed:extractText(text,ext==='csv'),...meta,contentType};
}
