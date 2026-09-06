import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {extractSupplierInvoice} from '../apps/api/src/supplier-parsers.js';
const samples=JSON.parse(fs.readFileSync(new URL('./fixtures/supplier-layouts.json',import.meta.url),'utf8'));
const expected:any={DOVE:['4453268','2026-09-01',32.5,7.6,6.02,46.12,1],SYNNEX:['V260064110','2026-06-19',3470,53.44,528.52,4051.96,2],INGRAM:['9929995378','2026-08-11',227.07,8.7,35.37,271.14,1],ROCTECH:['INVLGC42364','2026-08-19',4000,150,622.5,4772.5,3]};
for(const sample of samples){
 test(`${sample.code}: original PDF text reconciles headers, goods, freight and GST`,()=>{
  const p=extractSupplierInvoice(sample.extractedText)!;assert.ok(p);assert.deepEqual([p.invoiceNumber,p.invoiceDate?.toISOString().slice(0,10),p.subtotal,p.freight,p.tax,p.total,p.lines.length],expected[sample.code]);
  if(sample.code==='SYNNEX'){assert.deepEqual(p.lines.map(l=>[l.supplierCode,l.quantity]),[['B850M FORCE WF6E V2',10],['PRIME B550M-A WIFI II',10]]);assert.ok(p.lines.every(l=>!l.description.includes('SN261')));}
  if(sample.code==='ROCTECH'){assert.equal(p.lines[2].quantity,3);assert.equal(p.lines[2].unitCost,0);assert.equal(p.lines[2].supplierCode,'COOSEGFI6W');}
  if(sample.code==='DOVE'){assert.equal(p.lines[0].quantity,1);assert.equal(p.lines[0].supplierCode,'KB1202');}
  if(sample.code==='INGRAM')assert.equal(p.lines[0].supplierCode,'4705132');
 });
 test(`${sample.code}: inconsistent totals fail closed`,()=>{const altered=sample.extractedText.replace(/\d[\d,]*\.\d{2}(?=\s*(?:\n|$))/g,'999999.99');const p=extractSupplierInvoice(altered)!;assert.equal(p.lines.length,0);assert.equal(p.total,null);});
 test(`${sample.code}: credit note does not become a positive invoice`,()=>{assert.equal(extractSupplierInvoice('CREDIT NOTE\n'+sample.extractedText)?.lines.length,0);});
}
test('Dove uses supplied quantity rather than ordered quantity',()=>{const t=samples.find((s:any)=>s.code==='DOVE').extractedText.replace('DESKTOP KIT 1 32.50','DESKTOP KIT 5 32.50');assert.equal(extractSupplierInvoice(t)?.lines[0].quantity,1);});
test('Ingram uses shipped quantity rather than ordered quantity',()=>{const t=samples.find((s:any)=>s.code==='INGRAM').extractedText.replace('1 1 227.07 NZD','5 1 4 227.07 NZD');assert.equal(extractSupplierInvoice(t)?.lines[0].quantity,1);});
test('Synnex rejects multiple invoices bundled into one attachment',()=>{const t=samples.find((s:any)=>s.code==='SYNNEX').extractedText+'\nV260099999';assert.equal(extractSupplierInvoice(t)?.lines.length,0);});
