import type { DraftLine } from './invoice-extract.js';

// PB Tech's PDF text extraction emits price/total before code/quantity/GST.
// Accept this layout only when the entire table reconciles in integer cents.
export function extractPbInvoice(text: string) {
  if (!/PB Technologies Ltd/.test(text) || !/Description Qty Inv\. Price\s+Code Total\s+GST/.test(text)) return null;
  const invoiceNumber = text.match(/Tax Invoice (SI[A-Z0-9]+)/)?.[1];
  const date = text.match(/Invoice Date (\d{2})-([A-Za-z]+)-(\d{4})/);
  const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  const month = date ? months.indexOf(date[2].slice(0,3).toLowerCase()) : -1;
  if (!invoiceNumber || !date || month < 0) return null;
  const invoiceDate = new Date(Date.UTC(+date[3],month,+date[1]));
  if (invoiceDate.getUTCDate() !== +date[1]) return null;
  const cents = (s: string) => Math.round(Number(s.replace(/,/g,''))*100);
  const totals = text.match(/Total Ex GST GST Total Incl GST\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})/);
  if (!totals) return null;
  const table = text.split(/Description Qty Inv\. Price\s+Code Total\s+GST/)[1]?.split('CourierPost Tracking No:')[0];
  if (!table) return null;
  const rows = table.trim().split(/\r?\n/);
  const lines: DraftLine[] = [];
  let subtotal=0, freight=0, tax=0;
  for (const row of rows) {
    const m=row.trim().match(/^([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+([A-Z0-9-]+)\s+(\d+)\s+([\d,]+\.\d{2})\s+(.+)$/);
    if (!m) {
      if (!lines.length || /^\d/.test(row.trim())) return null;
      lines[lines.length-1].description+=' '+row.trim();
      continue;
    }
    const quantity=+m[4], unit=cents(m[1]), gross=cents(m[2]), gst=cents(m[5]);
    const net=unit*quantity;
    if (!quantity || quantity>100000 || Math.abs(net+gst-gross)>1 || Math.abs(Math.round(net*0.15)-gst)>1) return null;
    tax+=gst;
    if(m[3]==='FREIGHT') freight+=net;
    else { subtotal+=net; lines.push({supplierCode:m[3],description:m[6],quantity,unitCost:unit/100,lineTotal:net/100}); }
  }
  if (!lines.length || subtotal+freight!==cents(totals[1]) || tax!==cents(totals[2]) || subtotal+freight+tax!==cents(totals[3])) return null;
  const due=text.match(/Payment is due by \w+, (\d{1,2}) ([A-Za-z]+) (\d{4})/);
  const dueMonth=due?months.indexOf(due[2].slice(0,3).toLowerCase()):-1;
  const dueDate=due&&dueMonth>=0?new Date(Date.UTC(+due[3],dueMonth,+due[1])):null;
  return {invoiceNumber,invoiceDate,dueDate,subtotal:subtotal/100,freight:freight/100,tax:tax/100,total:cents(totals[3])/100,lines,warnings:['PB Tech layout detected and amounts reconciled. Verify the original invoice and confirm each SKU before approval.']};
}
