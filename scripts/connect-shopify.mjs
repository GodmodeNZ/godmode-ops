import {spawnSync} from 'node:child_process';
import {mkdirSync,existsSync,readFileSync,writeFileSync,unlinkSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');process.chdir(root);
const dir=resolve('.data/shopify-cli');mkdirSync(dir,{recursive:true});const cli=resolve(dir,'node_modules/@shopify/cli/bin/run.js');
const env={...process.env,SHOPIFY_CLI_NO_ANALYTICS:'1',SHOPIFY_CLI_AGENT_INFO:'n:GodmodeOps|v:1|p:OpenAI',SHOPIFY_CLI_AGENT_IDS:''};
try{
  if(!existsSync(cli)) {console.log('Installing the Shopify sign-in helper…');const r=spawnSync('npm',['install','--no-audit','--no-fund','@shopify/cli@4.7.1'],{cwd:dir,env,stdio:'inherit',shell:process.platform==='win32'});if(r.status!==0)throw new Error('Shopify helper could not be installed. Check your internet connection and try again.');}
  const domain='pcs-for-you.myshopify.com';
  console.log('Connecting Godmode. Sign in in the browser and approve read access for products, orders and customers.');
  const auth=spawnSync(process.execPath,[cli,'store','auth','--store',domain,'--scopes','read_products,read_orders,read_customers'],{env,stdio:'inherit'});if(auth.status!==0)throw new Error('Shopify sign-in was not completed. Run this file again to retry.');
  const queryFile=resolve(dir,'connection.graphql'),outputFile=resolve(dir,'connection-result.json');writeFileSync(queryFile,'query OpsConnection { shop { name myshopifyDomain } currentAppInstallation { accessScopes { handle } } }');
  const check=spawnSync(process.execPath,[cli,'store','execute','--store',domain,'--query-file',queryFile,'--output-file',outputFile,'--json'],{env,stdio:'inherit'});if(check.status!==0)throw new Error('Shopify could not verify the connection.');
  const response=JSON.parse(readFileSync(outputFile,'utf8')),data=response.data??response;if(data.errors||data.shop?.myshopifyDomain!==domain)throw new Error('The connected store was not Godmode.');
  writeFileSync('.data/shopify-cli.json',JSON.stringify({mode:'CLI',domain,name:data.shop.name,verifiedAt:new Date().toISOString(),scopes:data.currentAppInstallation?.accessScopes?.map(s=>s.handle)??[]},null,2),{mode:0o600});
  unlinkSync(outputFile);console.log('\nShopify is connected on this computer. Open the ERP → SKU Matching → Sync catalogue.\nIf your Shopify session expires, run Connect-Shopify.cmd again.');
}catch(e){console.error(e.message);process.exitCode=1;}
