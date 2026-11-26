#!/usr/bin/env node
// Bounded shadow experiment: NO writes to L-News items, source settings or API providers.
// Only URL fingerprints, public titles/links, and quota/status aggregates are retained.
// Secrets must come from runner environment. Never place provider credentials in output.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';

const started=new Date().toISOString();
const root=new URL('./',import.meta.url);
const baseline=JSON.parse(await readFile(new URL('./baseline-20261126.json',root),'utf8'));
const baselineKnown=new Map(baseline.items.map(([hash,domain,state])=>[hash,{domain,state}]));
const registered=new Set(baseline.domains);
const from='2026-11-24T12:00:00Z',to='2026-11-26T03:30:00Z';
const creds={currents:process.env.CURRENTSAPI_API_KEY||'',cloro:process.env.CLORO_API_KEY||'',thenews:process.env.THENEWSAPI_API_KEY||process.env.THE_NEWS_API_KEY||''};
const planned={currents:10,cloro:4,thenews:4};
const results={version:1,created_at:started,window_utc:[from,to],baseline:{observations:baseline.items.length,registered_domains:registered.size,notes:'Canonical URL overlap only; thematic/editorial relevance requires article review.'},key_present:Object.fromEntries(Object.entries(creds).map(([k,v])=>[k,Boolean(v)])),limit:planned,attempts:[],articles:[],comparison:{},warnings:[]};
const sleep=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));
const md5=(s)=>createHash('md5').update(s).digest('hex');
function canonical(url){
 try {
  const u=new URL(url);
  if(!/^https?:$/.test(u.protocol))return null;
  return (u.origin.toLowerCase()+u.pathname.replace(/\/+$/,'').toLowerCase()).replace(/\/+$/,'');
 }catch{return null;}
}
function host(url){try{return new URL(url).hostname.toLowerCase().replace(/^www\./,'');}catch{return '';}}
function knownDomain(domain){return registered.has(domain)||[...registered].some(d=>domain.endsWith('.'+d));}
const topical=/лукаш|лукашэн|lukash|loukach|lukaschen|łukasz|lukaš|lukaș|lukasenk|лукаше|卢卡|盧卡|루카셴|ლუკაშ|لوكاش/i;
function article(provider,tag,raw){
 const url=String(raw.url||raw.link||raw.web_url||'').trim();
 const can=canonical(url), domain=host(url);
 if(!url||!can)return null;
 const title=String(raw.title||raw.headline||'').trim().slice(0,280);
 const lead=String(raw.description||raw.snippet||raw.summary||'').trim().slice(0,300);
 const timestamp=raw.published||raw.published_at||raw.publishedAt||raw.date||null;
 const pubTime=timestamp?Date.parse(String(timestamp)):NaN;
 const published=Number.isFinite(pubTime)?new Date(pubTime).toISOString():null;
 const f=md5(can), baselineMatch=baselineKnown.get(f);
 const p={provider,query:tag,title,description:lead,url,domain,published,
  baseline_url_match:Boolean(baselineMatch),baseline_state:baselineMatch?.state||null,
  registered_source:knownDomain(domain),name_signal:topical.test(title+' '+lead),
  date_utc_known:Boolean(published),window_match:Boolean(published&&published>=from&&published<=to),
  canonical_fp:f,
  google_redirect:/^(news|www)\.google\./.test(domain)};
 results.articles.push(p);
 return p;
}
async function request(provider,tag,url,init={}){
 const a={provider,query:tag,status:null,count:0,error:null,elapsed_ms:0,meta:{}};
 const time=Date.now();
 try {
  const res=await fetch(url,{...init,signal:AbortSignal.timeout(25000)});
  a.status=res.status;
  // Parse only JSON, and never retain the raw server response.
  const body=await res.json().catch(()=>null);
  if(!res.ok){a.error=String(body?.code||body?.error?.code||body?.error||body?.message||'HTTP_error').slice(0,100).replace(/[^a-zA-Z0-9_ -]/g,'_');}
  a.meta.credits_charged=res.headers.get('x-credits-charged')||null;
  a.meta.credits_remaining=res.headers.get('x-credits-remaining')||null;
  a.elapsed_ms=Date.now()-time;results.attempts.push(a);
  return {a,body};
 }catch(e){
  a.error=e?.name==='TimeoutError'?'timeout':String(e?.code||e?.name||'network_error').slice(0,60);
  a.elapsed_ms=Date.now()-time;results.attempts.push(a);return {a,body:null};
 }
}
function unwrap(root,paths){
 for(const path of paths){let x=root;for(const k of path)x=x?.[k];if(Array.isArray(x))return x;}
 return [];
}
async function currents(){
 if(!creds.currents){results.warnings.push('Currents: no key available in GitHub runner environment');return;}
 const cases=[
  ['ru','Лукашенко','ru'],['uk','Лукашенко','uk'],
  ['pl','Łukaszenka','pl'],['fr','Loukachenko','fr'],
  ['de','Lukaschenko','de'],['en','Lukashenko','en'],
  ['en-interview','Lukashenko Macron Le Point','en'],
  ['ru-zelensky','Лукашенко Зеленский Москва','ru']
 ];
 let attempts=0;
 for(const [tag,keywords,language] of cases){
  let page=1;
  while(page<=2&&attempts<planned.currents){
   const url=new URL('https://api.currentsapi.services/v1/search');
   for(const [k,v] of Object.entries({keywords,language,page_number:String(page),page_size:'20',start_date:from,end_date:to,type:'1'}))url.searchParams.set(k,v);
   const {a,body}=await request('currents',tag+'#'+page,url,{headers:{Authorization:'Bearer '+creds.currents}});
   attempts++;
   const found=unwrap(body,[['news'],['data','news'],['articles']]);
   a.count=found.length;
   a.meta.total=typeof body?.total==='number'?body.total:(typeof body?.total_results==='number'?body.total_results:null);
   for(const item of found)article('currents',tag,item);
   if(a.status===401||a.status===403||a.status===429){results.warnings.push('Currents returned '+a.status+'; stopped early');return;}
   // One second page only for English and Russian broad queries and only if page one filled.
   if(a.status!==200||found.length<20||page!==1||!['ru','en'].includes(tag))break;
   page++;
   await sleep(350);
  }
 }
}
async function cloro(){
 if(!creds.cloro){results.warnings.push('Cloro: no key available in GitHub runner environment');return;}
 const cases=[
  ['US','Lukashenko Macron Le Point'],['PL','Łukaszenka wywiad Le Point'],
  ['FR','Loukachenko interview Le Point'],['UA','Лукашенко Зеленський Москва']
 ];
 for(const [country,query] of cases){
  const {a,body}=await request('cloro',country,'https://api.cloro.dev/v1/monitor/google/news',
    {method:'POST',headers:{Authorization:'Bearer '+creds.cloro,'Content-Type':'application/json'},body:JSON.stringify({query,country,pages:1})});
  const items=unwrap(body,[['newsResults'],['data','newsResults'],['result','newsResults'],['data','results'],['results']]);
  a.count=items.length;a.meta.success=body?.success??body?.data?.success??null;
  for(const item of items)article('cloro',country,{...item,url:item.link||item.url,published:item.published||null});
  if(a.status===401||a.status===403||a.status===429){results.warnings.push('Cloro returned '+a.status+'; stopped early');return;}
  await sleep(350);
 }
}
async function thenews(){
 if(!creds.thenews){results.warnings.push('TheNewsAPI: optional key is not configured; only historical control comparison possible');return;}
 const cases=[['en','Lukashenko'],['ru','Лукашенко'],['pl','Łukaszenka'],['fr','Loukachenko']];
 for(const [language,search] of cases){
  const url=new URL('https://api.thenewsapi.com/v1/news/all');
  for(const [k,v] of Object.entries({api_token:creds.thenews,search,language,limit:'3',published_after:from,published_before:to,sort:'published_at'}))url.searchParams.set(k,v);
  const {a,body}=await request('thenews',language,url);
  const entries=unwrap(body,[['data'],['articles'],['results']]);a.count=entries.length;
  a.meta.found=Number(body?.meta?.found??0)||null;
  for(const item of entries)article('thenews',language,{...item,published:item.published_at||item.published});
  if(a.status===401||a.status===403||a.status===429){results.warnings.push('TheNewsAPI returned '+a.status+'; stopped early');return;}
 }
}
await currents();await cloro();await thenews();

const pairs={currents_cloro:['currents','cloro'],currents_thenews:['currents','thenews'],cloro_thenews:['cloro','thenews'],currents_only:['currents'],cloro_only:['cloro'],thenews_only:['thenews']};
const group=(set)=>{
 const all=results.articles.filter(x=>set.includes(x.provider));
 const byUrl=new Map();
 for(const x of all){const old=byUrl.get(x.canonical_fp);if(!old||(!old.window_match&&x.window_match))byUrl.set(x.canonical_fp,x);}
 const unique=[...byUrl.values()];
 return {received:all.length,unique_urls:unique.length,unique_not_in_assistant_baseline:unique.filter(x=>!x.baseline_url_match).length,
  name_signal_in_new:unique.filter(x=>!x.baseline_url_match&&x.name_signal).length,
  new_from_registered_sources:unique.filter(x=>!x.baseline_url_match&&x.registered_source).length,
  dated_within_test_window:unique.filter(x=>x.window_match).length,
  google_redirects:unique.filter(x=>x.google_redirect).length,
  top_samples:unique.filter(x=>!x.baseline_url_match&&x.name_signal).slice(0,12).map(x=>({source:x.domain,title:x.title,url:x.url,published:x.published,query:x.query}))
 };
};
for(const [name,services] of Object.entries(pairs))results.comparison[name]=group(services);
for(const provider of ['currents','cloro','thenews'])results.comparison[provider]=group([provider]);
results.provider_summary=Object.fromEntries(['currents','cloro','thenews'].map(p=>{
 const rows=results.attempts.filter(x=>x.provider===p);
 return [p,{key_present:Boolean(creds[p]),requests:rows.length,http_ok:rows.filter(x=>x.status===200).length,results:rows.reduce((s,x)=>s+x.count,0),errors:rows.filter(x=>x.error).map(x=>({query:x.query,status:x.status,error:x.error})),charged_credits_reported:rows.map(x=>x.meta.credits_charged).filter(Boolean)}];
}));
results.finished_at=new Date().toISOString();
await mkdir('assistant2-benchmark-output',{recursive:true});
await writeFile('assistant2-benchmark-output/results.json',JSON.stringify(results,null,2));
const readable={created_at:results.created_at,summary:results.provider_summary,comparison:results.comparison,warnings:results.warnings};
console.log('=== Assistant 2 limited shadow benchmark: sanitized aggregates only ===');
console.log(JSON.stringify(readable,null,2));
console.log('No public application data was written. Full sanitized output: assistant2-benchmark-output/results.json');
