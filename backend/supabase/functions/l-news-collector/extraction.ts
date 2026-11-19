import {load} from 'npm:cheerio@1.0.0-rc.12';
import {Readability} from 'npm:@mozilla/readability@0.6.0';
import {parseHTML} from 'npm:linkedom@0.18.12';
import ipaddr from 'npm:ipaddr.js@2.2.0';
import {Candidate,Source,clean,contentLevel,domainOf,publicUrl,sourceFor} from './core.ts';
import {Job,Run,Runtime,must,reserve} from './providers.ts';

const MAX_BYTES=1500000;
export async function readLimited(response:Response):Promise<string>{
 const reader=response.body?.getReader();if(!reader)return '';
 const chunks:Uint8Array[]=[];let size=0;
 try{while(true){const r=await reader.read();if(r.done)break;size+=r.value.byteLength;if(size>MAX_BYTES){await reader.cancel();throw new Error('article_too_large');}chunks.push(r.value);}}finally{reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.byteLength;}return new TextDecoder().decode(bytes);
}
async function addressIsPublic(url:string){
 const safe=publicUrl(url);if(!safe)throw new Error('invalid_public_url');
 const host=new URL(safe).hostname;const ips=await Promise.race([Deno.resolveDns(host,'A').catch(()=>[]),new Promise<string[]>(resolve=>setTimeout(()=>resolve([]),4000))]);
 if(!ips.length||ips.some(ip=>{try{return ipaddr.parse(ip).range()!=='unicast';}catch{return true;}}))throw new Error('unverified_public_address');
}
export async function fetchPage(url:string):Promise<{html:string;url:string;status:number}>{
 let target=url;
 for(let redirect=0;redirect<4;redirect++){
  await addressIsPublic(target);
  const response=await fetch(target,{redirect:'manual',headers:{'user-agent':'Mozilla/5.0 (compatible; MonitorNewsResearch/1.0)','accept':'text/html,application/xhtml+xml','accept-language':'en,ru;q=0.7'},signal:AbortSignal.timeout(14000)});
  if(response.status>=300&&response.status<400){const location=response.headers.get('location');if(!location)throw new Error('redirect_without_location');target=new URL(location,target).href;continue;}
  if(!response.ok)return {html:'',url:target,status:response.status};
  const ct=response.headers.get('content-type')||'';if(ct&&!/html|xhtml/i.test(ct))return {html:'',url:target,status:415};
  return {html:await readLimited(response),url:target,status:response.status};
 }throw new Error('too_many_redirects');
}
export function extractPage(html:string,url:string){
 const $=load(html);let body='',published:string|null=null,paywall=false;
 function walk(v:any){if(!v||typeof v!=='object')return;if(v.isAccessibleForFree===false||v.isAccessibleForFree==='false')paywall=true;
  if(typeof v.articleBody==='string'&&v.articleBody.length>body.length){body=v.articleBody;published=v.datePublished||published;}
  if(/Article|Posting|Report/i.test(String(v['@type']||''))&&v.datePublished)published=String(v.datePublished);
  for(const child of Object.values(v)){if(child&&typeof child==='object')Array.isArray(child)?child.forEach(walk):walk(child);}}
 $('script[type="application/ld+json"]').each((_i,e)=>{try{walk(JSON.parse($(e).text()));}catch{/* malformed publisher metadata */}});
 const title=clean($('meta[property="og:title"]').attr('content')||$('h1').first().text()||$('title').text());
 const lead=clean($('meta[name="description"]').attr('content')||$('meta[property="og:description"]').attr('content'));
 published=published||$('meta[property="article:published_time"]').attr('content')||$('meta[itemprop="datePublished"]').attr('content')||$('time[datetime]').first().attr('datetime')||null;
 const canonical=$('link[rel="canonical"]').attr('href');const amp=$('link[rel="amphtml"]').attr('href');
 if(body.length<700){try{const document=(parseHTML(html) as any).document;const article=new Readability(document).parse();const text=article?.textContent?.trim()||'';if(text.length>body.length)body=text;}catch{/* DOM fallback below */}}
 if(body.length<350){$('script,style,nav,header,footer,aside,[class*="related"],[class*="recommend"]').remove();const nodes=$('article p,[itemprop="articleBody"] p,main p').toArray().map(e=>clean($(e).text())).filter(t=>t.length>40);if(nodes.join('\n\n').length>body.length)body=nodes.join('\n\n');}
 body=body.split(/\n+/).map(clean).filter(Boolean).join('\n\n').slice(0,150000);
 if(/subscribe to (?:continue|read)|подпишитесь.{0,25}читать|доступно.{0,15}подписчик|abonnez.vous pour lire|subscription required/i.test(body))paywall=true;
 return {body,title,lead,published,paywall,canonical:canonical?new URL(canonical,url).href:null,amp:amp?new URL(amp,url).href:null};
}
function sameArticle(title:string,other:string):boolean {
 const a=title.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu)||[],b=other.toLowerCase();return !a.length||a.filter(t=>b.includes(t)).length>=Math.min(3,Math.ceil(a.length*.35));
}
export async function recoverArticle(rt:Runtime,job:Job,run:Run,c:Candidate,source:Source,sources:Source[]){
 const startedRecovery=Date.now();
 const originalBody=c.body;let best={...c},level=contentLevel(c.body,!!c.paywall,!!c.content_truncated),strategy=c.body?'provider_content':'provider_metadata';
 const attempts:any[]=[];
 if(level==='FULL_TEXT')return {candidate:best,level,strategy,attempts};
 async function accept(html:string,url:string,route:string){
  const page=extractPage(html,url);
  if(!sameArticle(c.title,page.title))return null;
  if(page.body.length>best.body.length){best.body=page.body;best.paywall=page.paywall;best.content_truncated=false;strategy=route;}
  if(!best.lead&&page.lead)best.lead=page.lead;
  if(!best.published_at&&page.published)best.published_at=page.published;
  if(page.canonical&&sourceFor(page.canonical,sources)?.domain===source.domain&&new URL(page.canonical).pathname.length>1)best.canonical=page.canonical;
  level=contentLevel(best.body,!!best.paywall,!!best.content_truncated);return page;
 }
 try{const page=await fetchPage(c.url);attempts.push({route:'direct',status:page.status});
  if(page.html){const parsed=await accept(page.html,page.url,'publisher_direct');
   if(level!=='FULL_TEXT'&&parsed?.amp&&sourceFor(parsed.amp,sources)?.domain===source.domain){const amp=await fetchPage(parsed.amp);attempts.push({route:'amp',status:amp.status});if(amp.html)await accept(amp.html,amp.url,'publisher_amp');}}
 }catch(e){attempts.push({route:'direct',error:e instanceof Error?e.message:'transport_error'});}
 // Existing extraction entitlement, ordinary HTML only. Do not spend on a paywall.
 const wsKey=rt.secret('WEBSCRAPING_API_KEY','WEBSCRAPING_AI_API_KEY');
 if(level!=='FULL_TEXT'&&!best.paywall&&wsKey&&source.priority==='A'&&Date.now()-startedRecovery<25000){
  const reservation=await reserve(rt,job,run,'webscrapingai','html',0,run.settings.paid_extractions_per_run,120);
  if(reservation){const started=Date.now();let status=0;
   try{const q=new URLSearchParams({api_key:wsKey,url:c.url,js:'false',timeout:'15000'});const response=await fetch('https://api.webscraping.ai/html?'+q,{signal:AbortSignal.timeout(22000)});status=response.status;if(response.ok)await accept(await readLimited(response),c.url,'webscrapingai_html');}
   catch{attempts.push({route:'webscrapingai',error:'transport_or_timeout'});}
   attempts.push({route:'webscrapingai',status});must(await rt.db.from('l_news_usage').update({status,elapsed_ms:Date.now()-started,result_count:level==='FULL_TEXT'?1:0,details:{improved:best.body.length>originalBody.length}}).eq('id',reservation));
  }
 }
 return {candidate:best,level,strategy,attempts};
}
