import {Candidate,QUERY,ROLE_QUERY,clean,domainOf,perigonBudget} from './core.ts';
export type Runtime={db:any;secret:(...keys:string[])=>string;perigonKey:string;newscatcherKey:string};
export type Run={id:string;from_at:string;to_at:string;settings:any;warnings:any[];counters:any;status:string;number:number};
export type Job={id:number;run_id:string|null;kind:string;payload:any;attempts:number};
export const must=(r:any)=>{if(r.error)throw new Error(r.error.message);return r.data;};

export async function saveState(rt:Runtime,provider:string,info:any){must(await rt.db.from('l_news_provider_state').upsert({provider,info,updated_at:new Date().toISOString()}));}
export async function perigonLimits(rt:Runtime){
 const response=await fetch('https://api.perigon.io/v1/limits',{headers:{'x-api-key':rt.perigonKey},signal:AbortSignal.timeout(15000)});
 if(!response.ok)throw new Error('perigon_limits_'+response.status);const raw=await response.json();
 function find(key:string,v:any):any {if(v&&typeof v==='object'){if(key in v)return v[key];for(const x of Object.values(v)){const y=find(key,x);if(y!==undefined)return y;}}}
 const limits=Object.fromEntries(['requestsUsed','requestLimit','maxPageSize','paginationLimit','articleContentTruncation','since','lastMadeAt','resetAt'].map(k=>[k,find(k,raw)]).filter(([,v])=>v!==undefined));
 if(!Number.isFinite(Number(limits.requestsUsed))||!Number.isFinite(Number(limits.requestLimit)))throw new Error('perigon_unknown_quota_shape');
 await saveState(rt,'perigon',{configured:true,limits});return limits;
}
export async function newscatcherSubscription(rt:Runtime){
 const response=await fetch('https://api.newscatcherapi.com/news-api/subscription',{headers:{'x-api-key':rt.newscatcherKey},signal:AbortSignal.timeout(20000)});
 const value=await response.json().catch(()=>({}));
 if(response.ok){const safe=Object.fromEntries(['plan','credits_balance','articles','credits_per_search','requests_per_second','historical_days'].filter(k=>k in value).map(k=>[k,value[k]]));await saveState(rt,'newscatcher',{configured:true,family:'news-api',subscription:safe});return {family:'news-api',subscription:safe};}
 const old=await fetch('https://v3-api.newscatcherapi.com/api/subscription',{headers:{'x-api-token':rt.newscatcherKey},signal:AbortSignal.timeout(20000)});const v=await old.json().catch(()=>({}));
 const safe=Object.fromEntries(Object.entries(v).filter(([k])=>/^(active|subscription_plan|plan|remaining_calls|assigned_calls|api_calls|calls|rate_limit|concurrent_calls|max_page_size|historical_days|additional_info)/i.test(k)));
 if(!old.ok)throw new Error('newscatcher_subscription_'+old.status);
 await saveState(rt,'newscatcher',{configured:true,family:'v3',subscription:safe});return {family:'v3',subscription:safe};
}
export async function reserve(rt:Runtime,job:Job,run:Run|null,provider:string,endpoint:string,page:number,runLimit:number,monthLimit:number):Promise<number|null>{
 return must(await rt.db.rpc('l_news_reserve_call',{p_run:run?.id||null,p_job:job.id,p_provider:provider,p_endpoint:endpoint,p_page:page,p_run_limit:runLimit,p_month_limit:monthLimit}));
}
export async function apiRequest(rt:Runtime,job:Job,run:Run,provider:string,url:string,options:RequestInit,page:number,limit:number,credits:number){
 const id=await reserve(rt,job,run,provider,provider==='newscatcher'?'articles':'articles_all',page,limit,provider==='perigon'?150:1800);
 if(!id)return {capped:true,data:null,status:0};
 const started=Date.now();let status=0,data:any=null;
 try{const response=await fetch(url,{...options,signal:AbortSignal.timeout(30000)});status=response.status;data=await response.json().catch(()=>({}));}
 catch{data={error:'transport_or_timeout'};}
 const returned=(data?.articles||data?.results||[]).length;
 must(await rt.db.from('l_news_usage').update({status,result_count:returned,credits:status===200?credits:0,elapsed_ms:Date.now()-started,details:{attempt:job.attempts,total_hits:data?.total_hits??data?.numResults??null}}).eq('id',id));
 return {capped:false,data,status};
}
export async function searchPerigon(rt:Runtime,job:Job,run:Run){
 const info=job.payload.quota||await perigonLimits(rt);const page=Number(job.payload.page||0),size=Math.min(100,Number(info.maxPageSize)||100);
 const maxCalls=perigonBudget(info,run.settings.perigon_per_run,run.settings.perigon_reserve);
 if(maxCalls<1||page*size>=Number(info.paginationLimit||300))return {capped:true,candidates:[] as Candidate[],next:false};
 const q=new URLSearchParams({q:job.payload.layer==='role'?ROLE_QUERY:QUERY,searchTranslation:'true',from:run.from_at,to:run.to_at,sortBy:'date',showReprints:'true',page:String(page),size:String(size)});
 const response=await apiRequest(rt,job,run,'perigon','https://api.perigon.io/v1/all?'+q,{headers:{'x-api-key':rt.perigonKey}},page,maxCalls,0);
 if(response.capped)return {capped:true,candidates:[],next:false};
 if(response.status!==200)throw new Error('perigon_search_'+response.status);
 const data=response.data;if(!Array.isArray(data.articles))throw new Error('perigon_invalid_response');const list=data.articles;
 return {capped:false,candidates:list.map((a:any):Candidate=>({url:a.url,title:clean(a.title),title_en:clean(a.translatedTitle),lead:clean(a.description||a.summary),body:String(a.content||''),language:a.language||'',published_at:a.pubDate||null,country:String(a.source?.location?.country||'').toUpperCase(),domain:domainOf(a.url),provider:'perigon',provider_id:a.articleId||a.url,image:a.imageUrl,paywall:a.source?.paywall===true,content_truncated:info.articleContentTruncation!=null&&String(a.content||'').length>=Number(info.articleContentTruncation)})),
  next:(page+1)*size<Number(data.numResults||0),page,page_size:size,quota:info,total:Number(data.numResults||0)};
}
export async function searchNewscatcher(rt:Runtime,job:Job,run:Run){
 const family=job.payload.family||'news-api',page=Number(job.payload.page||1),size=100;
 const domains=job.payload.domains as string[];
 const params=family==='news-api'?{q:QUERY,search_in:['title_body','title_body_translated'],sources:domains,from_date:run.from_at,to_date:run.to_at,page_size:size,page,sort_by:'published_at',exclude_duplicates:false}:
 {q:QUERY,search_in:'title_content',sources:domains,from_:run.from_at,to_:run.to_at,page_size:size,page,sort_by:'date',exclude_duplicates:false};
 const response=await apiRequest(rt,job,run,'newscatcher',family==='news-api'?'https://api.newscatcherapi.com/news-api/articles':'https://v3-api.newscatcherapi.com/api/search',{method:'POST',headers:{'content-type':'application/json',[family==='news-api'?'x-api-key':'x-api-token']:rt.newscatcherKey},body:JSON.stringify(params)},page,run.settings.newscatcher_per_run,5);
 if(response.capped)return {capped:true,candidates:[],next:false};
 if(response.status!==200)throw new Error('newscatcher_search_'+response.status);
 const data=response.data,list=data.results||data.articles;if(!Array.isArray(list))throw new Error('newscatcher_invalid_response');
 return {capped:false,candidates:list.map((a:any):Candidate=>({url:a.url||a.link,title:clean(a.title),title_en:clean(a.title_en),lead:clean(a.snippet||a.description||a.summary),body:String(a.content||''),published_at:a.published_at||a.published_date||null,language:a.language||'',country:String(a.country||'').toUpperCase(),domain:domainOf(a.url||a.link),provider:'newscatcher',provider_id:a.id||a._id||a.url||a.link,image:a.image_url||a.media,paywall:false,content_truncated:family==='news-api'})),next:page<Number(data.total_pages||1),page,page_size:size,total:Number(data.total_hits||0)};
}
export async function searchGdelt(rt:Runtime,job:Job,run:Run){
 const id=await reserve(rt,job,run,'gdelt','doc',0,run.settings.gdelt_per_run,10000);if(!id)return {capped:true,candidates:[],split:false};
 const from=job.payload.from||run.from_at,to=job.payload.to||run.to_at;const stamp=(v:string)=>new Date(v).toISOString().replace(/[-:T]/g,'').slice(0,14);
 const q=new URLSearchParams({query:'(Lukashenko OR Lukashenka) -sourcecountry:belarus',mode:'artlist',format:'json',startdatetime:stamp(from),enddatetime:stamp(to),maxrecords:'250',sort:'datedesc'});
 const start=Date.now();const response=await fetch('https://api.gdeltproject.org/api/v2/doc/doc?'+q,{signal:AbortSignal.timeout(25000)});const raw=await response.text();let data:any;try{data=JSON.parse(raw);}catch{data={};}const list=data.articles||[];
 must(await rt.db.from('l_news_usage').update({status:response.status,result_count:list.length,credits:0,elapsed_ms:Date.now()-start}).eq('id',id));if(!response.ok)throw new Error('gdelt_search_'+response.status);if(!Array.isArray(data.articles))throw new Error('gdelt_transport_invalid_response_'+raw.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').slice(0,120));
 return {capped:false,candidates:list.map((a:any):Candidate=>({url:a.url,title:clean(a.title),lead:'',body:'',published_at:null,language:String(a.language||'').toLowerCase(),country:'',domain:domainOf(a.url),provider:'gdelt',provider_id:a.url,image:a.socialimage})),split:list.length>=250&&Date.parse(to)-Date.parse(from)>3600000,from,to};
}
