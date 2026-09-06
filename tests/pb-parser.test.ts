import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPbInvoice } from '../apps/api/src/pb-parser.js';
const fixture=`PB Technologies Ltd
Tax Invoice SIHD7292123
Invoice Date 03-Sept-2026
Description Qty Inv. Price\tCode Total\tGST
115.97 666.83\tCHANZX0611 5 86.98\tNZXT H6 Flow Dual Chamber - Tempered Glass ATX
Mid Tower Gaming Case - White
(MPN: CC-H61FW-01)
82.52 94.90\tFREIGHT 1 12.38\tFREIGHT
CourierPost Tracking No:
Total Ex GST GST Total Incl GST
662.37 99.36 761.73
Payment is due by Tuesday, 20 October 2026`;
test('PB Tech reordered PDF columns reconcile and separate freight',()=>{
 const p=extractPbInvoice(fixture)!; assert.ok(p); assert.equal(p.invoiceNumber,'SIHD7292123'); assert.equal(p.invoiceDate.toISOString(),'2026-09-03T00:00:00.000Z'); assert.equal(p.dueDate?.toISOString(),'2026-10-20T00:00:00.000Z');
 assert.deepEqual([p.subtotal,p.freight,p.tax,p.total],[579.85,82.52,99.36,761.73]); assert.equal(p.lines.length,1); assert.equal(p.lines[0].supplierCode,'CHANZX0611'); assert.equal(p.lines[0].quantity,5); assert.equal(p.lines[0].unitCost,115.97); assert.match(p.lines[0].description,/CC-H61FW-01/);
});
test('PB Tech extraction rejects inconsistent or unsupported tables',()=>{
 for(const bad of [fixture.replace('666.83','666.84').replace('761.73','999.00'),fixture.replace('CHANZX0611 5','CHANZX0611 6'),fixture.replace('82.52 94.90','82.52 99.90'),fixture.replace('PB Technologies Ltd','Another supplier')]) assert.equal(extractPbInvoice(bad),null);
});
