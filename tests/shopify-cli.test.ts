import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {executeLocalShopify} from '../apps/api/src/shopify-local.js';
await test('Windows-compatible Shopify runner uses files, read-only flags and parses CLI JSON',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'godmode cli test ')),cliPath=join(dir,'mock-cli.mjs');
 try{
  await writeFile(cliPath,`import {readFileSync,writeFileSync} from 'node:fs';import assert from 'node:assert/strict';const args=process.argv.slice(2),value=k=>args[args.indexOf(k)+1];assert.equal(args[0],'store');assert.equal(args[1],'execute');assert.equal(value('--store'),'test.myshopify.com');assert.ok(!args.includes('--allow-mutations'));assert.equal(JSON.parse(readFileSync(value('--variable-file'),'utf8')).title,"Bob's $item & component");assert.ok(readFileSync(value('--query-file'),'utf8').includes('shop'));writeFileSync(value('--output-file'),JSON.stringify({data:{shop:{name:'Test'}}}));`);
  const r=await executeLocalShopify({cliPath,domain:'test.myshopify.com'},'query { shop { name } }',{title:"Bob's $item & component"});assert.equal(r.shop.name,'Test');
 }finally{await rm(dir,{recursive:true,force:true});}
});
