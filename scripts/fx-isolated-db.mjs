import {Client} from 'pg';
import {mkdirSync,writeFileSync,readFileSync,readdirSync,cpSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const admin=new URL(process.env.FX_TEST_ADMIN_URL??'');
const database='godmode_fx_isolated_test_'+Date.now();
const client=new Client({connectionString:admin.toString()});await client.connect();
try{await client.query('CREATE DATABASE "'+database+'"');}finally{await client.end();}
const url=new URL(admin);url.pathname='/'+database;url.searchParams.set('schema','public');
mkdirSync('.data/fx-test-bootstrap/migrations',{recursive:true});
writeFileSync('.data/fx-test-url',url.toString());
writeFileSync('.data/fx-test-bootstrap/schema.prisma',readFileSync('prisma/schema.prisma'));
for(const name of readdirSync('prisma/migrations'))if(name<'202609060001_multicurrency')cpSync('prisma/migrations/'+name,'.data/fx-test-bootstrap/migrations/'+name,{recursive:true});
process.env.DATABASE_URL=url.toString();
function run(args){const r=spawnSync(process.execPath,args,{stdio:'inherit',env:process.env});if(r.status!==0)throw new Error('Isolated migration failed');}
run(['node_modules/prisma/build/index.js','migrate','deploy','--schema','.data/fx-test-bootstrap/schema.prisma']);
const fixture=new Client({connectionString:url.toString()});await fixture.connect();
try{
 await fixture.query(`INSERT INTO "SupplierInvoice" (id,fingerprint,source,currency,"invoiceNumber","invoiceDate",subtotal,tax,freight,total,"extractedText","extractionWarnings","updatedAt") VALUES
 ('fx-legacy-aud','fx-legacy-aud','TEST','AUD','FX-LEGACY-AUD','2026-03-06',100,0,0,100,'Historical foreign record','[]',NOW()),
 ('fx-legacy-nzd','fx-legacy-nzd','TEST','NZD','FX-LEGACY-NZD','2026-03-06',100,15,0,115,'Historical NZD record','[]',NOW());`);
 await fixture.query(`
 INSERT INTO "Supplier" (id,code,name,"updatedAt") VALUES ('fx-legacy-supplier','FX-LEGACY','Legacy test supplier',NOW());
 INSERT INTO "ComponentFamily" (id,name,category,"updatedAt") VALUES ('fx-legacy-family','Legacy FX test family','TEST',NOW());
 INSERT INTO "Sku" (id,code,name,"familyId","updatedAt") VALUES ('fx-legacy-sku','FX-LEGACY-SKU','Historical foreign component','fx-legacy-family',NOW());
 INSERT INTO "Location" (id,code,name) VALUES ('fx-legacy-location','FX-LEGACY-LOC','Legacy test location');
 INSERT INTO "PurchaseOrder" (id,number,"supplierId",status,currency,"updatedAt") VALUES ('fx-legacy-po','FX-LEGACY-PO','fx-legacy-supplier','PARTIALLY_RECEIVED','USD',NOW());
 INSERT INTO "PurchaseOrderLine" (id,"purchaseOrderId","skuId","quantityOrdered","quantityReceived","unitCost","updatedAt") VALUES ('fx-legacy-pol','fx-legacy-po','fx-legacy-sku',2,1,10,NOW());
 INSERT INTO "InventoryTransaction" (id,"skuId","locationId","quantityDelta",type,"unitCost","referenceType","referenceId") VALUES ('fx-legacy-movement','fx-legacy-sku','fx-legacy-location',1,'PURCHASE_RECEIPT',10,'PURCHASE_ORDER','fx-legacy-po');
 `);
}finally{await fixture.end();}
run(['node_modules/prisma/build/index.js','migrate','deploy']);
console.log('Created and migrated disposable database '+database+' with legacy currency fixtures.');
