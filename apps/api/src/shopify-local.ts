import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ensure } from './core.js';
export function localShopifyConfig():any|null {
  if(process.env.LOCAL_POSTGRES!=='true'&&process.env.SHOPIFY_USE_CLI!=='true')return null;
  const root=resolve(process.env.ERP_DATA_DIR??'.data'),file=resolve(root,'shopify-cli.json');if(!existsSync(file))return null;
  const c=JSON.parse(readFileSync(file,'utf8'));if(!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(c.domain))return null;
  return {...c,mode:'CLI',cliPath:resolve(root,'shopify-cli/node_modules/@shopify/cli/bin/run.js')};
}
export async function executeLocalShopify(config:any,query:string,variables:object){
  const dir=await mkdtemp(join(tmpdir(),'godmode-shopify-'));const queryFile=join(dir,'query.graphql'),variablesFile=join(dir,'variables.json'),outputFile=join(dir,'result.json');
  try{
    ensure(existsSync(config.cliPath),'Run Connect-Shopify.cmd to install and connect Shopify on this computer',503);
    await writeFile(queryFile,query,{mode:0o600});await writeFile(variablesFile,JSON.stringify(variables),{mode:0o600});
    const env={...process.env,SHOPIFY_CLI_NO_ANALYTICS:'1',SHOPIFY_CLI_AGENT_INFO:'n:GodmodeOps|v:1|p:OpenAI',SHOPIFY_CLI_AGENT_IDS:''};delete (env as any).SHOPIFY_FLAG_ALLOW_MUTATIONS;
    try { await promisify(execFile)(process.execPath,[config.cliPath,'store','execute','--store',config.domain,'--query-file',queryFile,'--variable-file',variablesFile,'--output-file',outputFile,'--json','--version',process.env.SHOPIFY_API_VERSION??'2026-07'],{env,timeout:60000,maxBuffer:4*1024*1024,windowsHide:true}); }
    catch {ensure(false,'Shopify sign-in expired or the request failed. Run Connect-Shopify.cmd again, then retry.',502);}
    const result=JSON.parse(await readFile(outputFile,'utf8'));ensure(!result.errors,'Shopify denied the query. Reconnect with the required read access.',502);return result.data??result;
  }finally{await rm(dir,{recursive:true,force:true});}
}
