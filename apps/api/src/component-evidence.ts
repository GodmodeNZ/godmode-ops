export const canonical = (s: string | null | undefined) => (s ?? '').normalize('NFKC').trim().toUpperCase().replace(/\s+/g, ' ');
export function referenceSuggestions(input:{description:string;code?:string|null;barcode?:string|null},records:{id:string;code?:string|null;barcode?:string|null;name:string}[]){
 const words=(s:string)=>new Set(canonical(s).replace(/[^A-Z0-9]+/g,' ').split(' ').filter(x=>x.length>1));const a=words(input.description);
 const mpn=input.description.match(/\bMPN\s*:\s*([^\s)]+)/i)?.[1];
 return records.map(r=>{const evidence:string[]=[];let score=0;if(input.code&&r.code&&canonical(input.code)===canonical(r.code)){score=95;evidence.push('Exact source SKU/code');}if(mpn&&r.code&&canonical(mpn)===canonical(r.code)){score=98;evidence.push('Exact manufacturer part number from invoice');}if(input.barcode&&r.barcode&&canonical(input.barcode)===canonical(r.barcode)){score=99;evidence.push('Exact barcode');}const b=words(r.name),shared=[...a].filter(x=>b.has(x)).length,similarity=shared/Math.max(a.size,b.size,1);if(shared>=2&&similarity>=.25){score=Math.max(score,Math.round(similarity*75));evidence.push('Name similarity only — identity not confirmed');}if([...a].some(t=>/\d{3,}/.test(t)&&/[A-Z]/.test(t)&&!/^\d+(GB|TB|MB|MHZ|GHZ|MT|RPM|W)$/.test(t)&&b.has(t))&&shared>=2){score=Math.max(score,80);evidence.push('Matching model token — verify all specifications');}return {...r,score,evidence};}).filter(r=>r.score>0).sort((a,b)=>b.score-a.score).slice(0,5).map(r=>({...r,conflicts:specificationConflicts(input.description,r.name)}));
}
export function specifications(name: string) {
  const text = canonical(name);
  const colours = [...new Set(text.match(/\b(BLACK|WHITE|SILVER|RED|BLUE|PINK|GREY|GRAY)\b/g) ?? [])].map(x=>x==='GRAY'?'GREY':x).sort();
  const capacities = [...new Set([...text.matchAll(/\b(\d+(?:\.\d+)?)\s*(TB|GB|MB)\b/g)].map(m=>String(Number(m[1])*(m[2]==='TB'?1024:m[2]==='GB'?1:1/1024))))].sort();
  const kit = text.match(/\b(\d+)\s*[X×]\s*\d+\s*(?:GB|TB|MM)\b/)?.[1] ?? text.match(/\b(\d+)\s*(?:PACK|PK|PIECE|PCS)\b/)?.[1] ?? text.match(/\b(?:PACK|KIT)\s*(?:OF\s*)?(\d+)\b/)?.[1];
  const models = [...new Set([...(text.match(/\b[A-Z]*\d+[A-Z0-9-]*\b/g) ?? []).filter(x=>/[A-Z]/.test(x)&&!/^(?:DDR\d|\d+(?:GB|TB|MB|MM|W|MHZ|GHZ|PACK|PK))$/.test(x)),...[...text.matchAll(/\b(?:RTX|GTX|RX|ARC|RYZEN\s*[3579]?)\s*(\d{3,5}(?:\s*(?:SUPER|TI|XT|XTX|X3D|X))?)\b/g)].map(m=>m[0])])].sort();
  return { colours, capacities, pack: kit ? Number(kit) : /\b(SINGLE|EACH|UNIT)\b/.test(text)?1:null, kit: /\bKIT\b/.test(text)||Boolean(kit&&Number(kit)>1), models };
}
export function specificationConflicts(a: string, b: string) {
  const x=specifications(a),y=specifications(b), conflicts:string[]=[];
  for(const key of ['colours','capacities','models'] as const)if(x[key].length&&y[key].length&&JSON.stringify(x[key])!==JSON.stringify(y[key]))conflicts.push(`${key}: ${x[key].join('/')} versus ${y[key].join('/')}`);
  if(x.pack!=null&&y.pack!=null&&x.pack!==y.pack)conflicts.push(`Pack quantity: ${x.pack} versus ${y.pack}`);
  if(x.kit!==y.kit)conflicts.push('Unit versus kit/pack: verify the sellable unit');
  return conflicts;
}
export function finishedPc(v: {productTitle:string;productType:string}) {
  if(/^(PC|PCS|COMPUTERS|DESKTOPS|SYSTEMS)$/i.test(v.productType.trim()))return true;
  if(/\b(PC CASE|COMPUTER CASE|PC COOLER|PC POWER SUPPLY)\b/i.test(v.productTitle)||/\b(CASES?|CHASSIS|MOTHERBOARDS?|MEMORY|RAM|COOLERS?|GRAPHICS CARDS?)\b/i.test(v.productType))return false;
  return /\b(GAMING PC|DESKTOP PC|CUSTOM PC|PREBUILT|PRE-BUILT|BUILT TO ORDER|COMPLETE PC|GAMING COMPUTER)\b/i.test(v.productTitle+' '+v.productType)||/^(PC|PCS|COMPUTERS|DESKTOPS|SYSTEMS)$/i.test(v.productType.trim());
}
// RFC-style quoted CSV, including embedded newlines. Only the two catalogue columns leave this parser.
export function catalogueCandidates(csv:string) {
  const rows:string[][]=[];let row:string[]=[],value='',quoted=false;
  for(let i=0;i<csv.length;i++){const c=csv[i];if(c==='"'){if(quoted&&csv[i+1]==='"'){value+='"';i++;}else quoted=!quoted;}else if(c===','&&!quoted){row.push(value);value='';}else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&csv[i+1]==='\n')i++;row.push(value);rows.push(row);row=[];value='';}else value+=c;}
  if(quoted)throw Error('Unclosed quoted CSV cell');if(value||row.length){row.push(value);rows.push(row);}
  let sku=-1,name=-1,found=false;const result:{row:number;code:string;name:string}[]=[];
  rows.forEach((r,i)=>{const header=r.map(canonical);if(header.includes('SKU')&&header.includes('PRODUCT NAME')){sku=header.indexOf('SKU');name=header.indexOf('PRODUCT NAME');found=true;return;}if(sku<0)return;const code=(r[sku]??'').trim(),description=(r[name]??'').trim();if(!code&&!description)return;if(!description&&!code)return;if(/^TOTAL\b|^#REF!|^BIN COUNT/i.test(code+' '+description))return;result.push({row:i+1,code,name:description});});
  if(!found)throw Error('CSV must contain SKU and Product Name headers');return result;
}
