import 'dotenv/config';
import {PrismaClient,Prisma} from '@prisma/client';

const db=new PrismaClient();
const write=process.argv.includes('--write');
const shopRaw=(process.env.SHOPIFY_STORE_DOMAIN??'').trim().replace(/^https?:\/\//,'').replace(/\/$/,'');
const shop=shopRaw.endsWith('.myshopify.com')?shopRaw:shopRaw?`${shopRaw}.myshopify.com`:'';
const clientId=process.env.SHOPIFY_CLIENT_ID??'';
const clientSecret=process.env.SHOPIFY_CLIENT_SECRET??'';
const legacyToken=process.env.SHOPIFY_ADMIN_ACCESS_TOKEN??'';
const version=process.env.SHOPIFY_API_VERSION??'2026-07';
if(!shop)throw new Error('Set SHOPIFY_STORE_DOMAIN to your myshopify store domain or subdomain in .env');
if(!legacyToken&&(!clientId||!clientSecret))throw new Error('Set SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET in .env');

async function readJson(r:Response,label:string){const text=await r.text();let j:any;try{j=JSON.parse(text)}catch{throw new Error(`${label} returned HTTP ${r.status} ${r.statusText}, content-type ${r.headers.get('content-type')??'unknown'}: ${text.slice(0,500)}`)}return j}
let cachedToken='';
async function accessToken(){
 if(legacyToken)return legacyToken;
 if(cachedToken)return cachedToken;
 const r=await fetch(`https://${shop}/admin/oauth/access_token`,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'client_credentials',client_id:clientId,client_secret:clientSecret})});
 const j:any=await readJson(r,'Shopify token endpoint');
 if(!r.ok||!j.access_token)throw new Error(`Shopify authentication failed (${r.status}): ${JSON.stringify(j)}`);
 cachedToken=j.access_token;
 return cachedToken;
}

type Variant={id:string;title:string;sku:string|null;price:string;inventoryQuantity:number};
type Product={id:string;title:string;handle:string;status:string;productType:string;vendor:string;tags:string[];variants:{nodes:Variant[]}};
const query=`query Products($after:String){products(first:100,after:$after,query:"status:active"){nodes{id title handle status productType vendor tags variants(first:100){nodes{id title sku price inventoryQuantity}}}pageInfo{hasNextPage endCursor}}}`;
async function gql(after:string|null){const token=await accessToken();const r=await fetch(`https://${shop}/admin/api/${version}/graphql.json`,{method:'POST',headers:{'content-type':'application/json','X-Shopify-Access-Token':token},body:JSON.stringify({query,variables:{after}})});const j:any=await readJson(r,'Shopify GraphQL endpoint');if(!r.ok||j.errors)throw new Error(`Shopify GraphQL failed (${r.status}): ${JSON.stringify(j.errors??j)}`);return j.data.products as {nodes:Product[];pageInfo:{hasNextPage:boolean;endCursor:string|null}}}
const numeric=(gid:string)=>gid.split('/').pop()!;
const cleanCode=(s:string)=>s.toUpperCase().replace(/[^A-Z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,80);
const isBuilder=(p:Product)=>p.tags.includes('builder-component')||p.tags.includes('internal-component')||p.productType.startsWith('Builder');
const category=(p:Product,v:Variant)=>{const t=(p.productType+' '+(v.sku??'')+' '+p.title).toUpperCase();for(const x of ['CPU','GPU','RAM','SSD','MOTHERBOARD','COOLER','CASE','PSU','WARRANTY'])if(t.includes(x))return x;return 'COMPONENT'};

async function main(){console.log(`Shopify shop: ${shop}`);let after:null|string=null,products:Product[]=[];do{const page=await gql(after);products.push(...page.nodes);after=page.pageInfo.hasNextPage?page.pageInfo.endCursor:null}while(after);
 const pcProducts=products.filter(p=>p.productType==='Gaming PC');
 const builderProducts=products.filter(p=>p.productType!=='Gaming PC'&&isBuilder(p));
 const builderVariants=builderProducts.flatMap(p=>p.variants.nodes.map(v=>({p,v,cat:category(p,v)})));
 const byCategory=Object.entries(builderVariants.reduce<Record<string,number>>((a,x)=>{a[x.cat]=(a[x.cat]??0)+1;return a},{})).sort((a,b)=>a[0].localeCompare(b[0]));
 console.log(`Shopify catalogue scan: ${products.length} active products`);
 console.log(`Gaming PCs: ${pcProducts.length} -> ${pcProducts.map(p=>p.title).join(', ')||'none'}`);
 console.log(`Builder products: ${builderProducts.length}; component variants: ${builderVariants.length}`);
 console.log(`Categories: ${byCategory.map(([k,v])=>`${k}=${v}`).join(', ')}`);
 if(!write){console.log('DRY RUN ONLY — no ERP records changed. Re-run with: npm run shopify:sync -- --write');return}
 let pcs=0,components=0,variants=0,mappings=0;
 for(const p of products){
  if(p.productType==='Gaming PC'){
   const code=cleanCode(p.title||p.handle)||`SHOPIFY-PC-${numeric(p.id)}`;
   const gp=await db.product.upsert({where:{code},update:{name:p.title,active:true},create:{code,name:p.title}});pcs++;
   const existing=await db.shopifyProductMapping.findFirst({where:{shopifyProductId:numeric(p.id),shopifyVariantId:null,productId:gp.id}});
   if(!existing){await db.shopifyProductMapping.create({data:{shopDomain:shop,shopifyProductId:numeric(p.id),productId:gp.id,priority:50}});mappings++}
   for(const v of p.variants.nodes){const vm=await db.shopifyProductMapping.findFirst({where:{shopifyVariantId:numeric(v.id),productId:gp.id}});if(!vm){await db.shopifyProductMapping.create({data:{shopDomain:shop,shopifyProductId:numeric(p.id),shopifyVariantId:numeric(v.id),sku:v.sku||undefined,productId:gp.id,priority:10}});mappings++}}
   continue;
  }
  if(!isBuilder(p))continue;
  for(const v of p.variants.nodes){const cat=category(p,v);const family=await db.componentFamily.upsert({where:{name:p.title},update:{category:cat,attributes:{shopifyProductId:numeric(p.id),productType:p.productType,tags:p.tags} as Prisma.InputJsonValue},create:{name:p.title,category:cat,attributes:{shopifyProductId:numeric(p.id),productType:p.productType,tags:p.tags} as Prisma.InputJsonValue}});const code=(v.sku&&v.sku.trim())||`SHOPIFY-VARIANT-${numeric(v.id)}`;await db.sku.upsert({where:{code},update:{name:p.title,familyId:family.id,active:true,attributes:{shopifyProductId:numeric(p.id),shopifyVariantId:numeric(v.id),variantTitle:v.title,price:v.price,shopifyInventory:v.inventoryQuantity,vendor:p.vendor,handle:p.handle,tags:p.tags} as Prisma.InputJsonValue},create:{code,name:p.title,familyId:family.id,attributes:{shopifyProductId:numeric(p.id),shopifyVariantId:numeric(v.id),variantTitle:v.title,price:v.price,shopifyInventory:v.inventoryQuantity,vendor:p.vendor,handle:p.handle,tags:p.tags} as Prisma.InputJsonValue}});variants++}components++;
 }
 console.log(`WRITE COMPLETE: ${pcs} gaming PCs, ${components} builder products, ${variants} component variants, ${mappings} new Shopify mappings.`);
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>db.$disconnect());