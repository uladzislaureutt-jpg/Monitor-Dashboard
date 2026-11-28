import {Candidate,NAMES,clean} from './core.ts';
import {CURRENTS_TERMS} from './discovery.ts';
import {CLORO_PROFILES} from './cloro-config.ts';
import {Runtime,Run,Job,must} from './providers.ts';

export const NEWSDATA_DELAY_HOURS=12;
export function newsdataQueries(){
 const terms=[...new Set(['Lukashenko','Lukashenka','Лукашенко','Лукашенка','Лукашэнка',...NAMES,...Object.values(CURRENTS_TERMS).flat(),...Object.values(CLORO_PROFILES).flatMap(p=>p.terms)])];
 const groups:{kind:string;q:string}[]=[];let q='';
 for(const term of terms){const next=q?q+' OR '+term:term;if(next.length>100){groups.push({kind:'name',q});q=term;}else q=next;}
 if(q)groups.push({kind:'name',q});
 for(const q of ['"President of Belarus" OR "Belarusian president"','"президент Беларуси" OR "президент Белоруссии"','"prezydent Białorusi" OR "білоруський президент"','"Präsident von Belarus" OR "belarussische Präsident"','"président biélorusse" OR "président du Bélarus"','"presidente bielorusso" OR "presidente bielorruso" OR "presidente da Bielorrússia"','"Beyaz Rusya Cumhurbaşkanı" OR "Belarus Cumhurbaşkanı"','白俄罗斯总统 OR 白俄羅斯總統 OR ベラルーシ大統領 OR "الرئيس البيلاروسي"'])groups.push({kind:'role',q});
 return groups;
}
export function newsdataWindow(at:string,hours=26){
 const to=Math.floor(Date.parse(at)/60000)*60000-12*3600000-60000;
 return {from:new Date(to-hours*3600000).toISOString(),to:new Date(to).toISOString()};
}
export function validateNewsdataSettings(body:Record<string,unknown>,countries:string[]){
 const patch:Record<string,unknown>={updated_at:new Date().toISOString()};
 for(const [field,min,max] of [['lookback_hours',1,168],['newsdata_per_run',0,180],['newsdata_daily_credits',0,200],['newsdata_monthly_credits',0,6000],['newsdata_reserve',0,199],['candidate_limit',10,3000],['rechecks_per_run',0,50]] as const){
  if(body[field]===undefined)continue;const n=Number(body[field]);if(typeof body[field]==='boolean'||!Number.isInteger(n)||n<min||n>max)throw Error('invalid_'+field);patch[field]=n;
 }
 if(body.enabled!==undefined){if(typeof body.enabled!=='boolean')throw Error('invalid_enabled');patch.enabled=body.enabled;}
 if(body.local_time!==undefined){if(typeof body.local_time!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(body.local_time))throw Error('invalid_local_time');patch.local_time=body.local_time;}
 if(body.countries!==undefined){if(!Array.isArray(body.countries)||!body.countries.length||body.countries.some(c=>typeof c!=='string'||!countries.includes(c)))throw Error('invalid_countries');patch.countries=[...new Set(body.countries)];}
 return patch;
}
const number=(s:unknown)=>s===null||s===undefined||s===''?null:Number.isFinite(Number(s))?Number(s):null;
export function newsdataHeaders(headers:Headers){
 const n=(name:string,alias?:string)=>number(headers.get(name)??(alias?headers.get(alias):null));
 return {remaining:n('x-api-limit-remaining','x_api_limit_remaining'),limit:200,rate_remaining:n('x-ratelimit-remaining','x_rate_limit_remaining'),rate_limit:n('x-ratelimit-limit'),rate_reset:n('x-ratelimit-reset')};
}
export function newsdataCandidate(a:any):Candidate{
 return {url:String(a.url||a.link||''),title:clean(a.title),lead:clean(a.meta_description||a.description),body:'',published_at:a.published_at||a.pubDate||null,language:String(a.language||''),country:'',domain:'',provider:'newsdata',provider_id:String(a.id||a.article_id||a.url||a.link),content_truncated:true};
}
export async function probeNewsdata(rt:Runtime){
 const previous=must(await rt.db.from('l_news_provider_state').select('info,updated_at').eq('provider','newsdata').maybeSingle());
 return {configured:!!rt.secret('NEWSDATA_API_KEY'),limits:previous?.info.limits??null,checked_at:previous?.updated_at??null,cached:true};
}
export async function searchNewsdata(rt:Runtime,job:Job,run:Run){
 const key=rt.secret('NEWSDATA_API_KEY');if(!key)return {capped:true,warnings:['NewsData: ключ отсутствует']};
 const query=newsdataQueries()[Number(job.payload.query_index)];if(!query)throw Error('newsdata_invalid_query');
 const cursor=job.payload.cursor;if(cursor&&(typeof cursor!=='string'||cursor.length>200||!/^[a-zA-Z0-9_=.-]+$/.test(cursor)))throw Error('newsdata_invalid_cursor');
 const previous=must(await rt.db.from('l_news_provider_state').select('info').eq('provider','newsdata').maybeSingle())?.info||{};
 if(Date.parse(previous.retry_at||'')>Date.now())return {retry_at:previous.retry_at};
 const id=must(await rt.db.rpc('l_news_reserve_newsdata_call',{p_run:run.id,p_job:job.id,p_page:Number(job.payload.page||1)}));
 if(!id)return {capped:true};
 const params=new URLSearchParams({apikey:key,q:query.q,size:'10',from_date:run.from_at.slice(0,19).replace('T',' '),to_date:run.to_at.slice(0,19).replace('T',' ')});
 // PostgREST timestamps use +00:00; normalize through Date to preserve seconds.
 params.set('from_date',new Date(run.from_at).toISOString().slice(0,19).replace('T',' '));params.set('to_date',new Date(run.to_at).toISOString().slice(0,19).replace('T',' '));
 if(cursor)params.set('page',cursor);
 let status=0,data:any={},limits:any=null,retryAt:string|null=null;const started=Date.now();
 try{const r=await fetch('https://newsdata.io/api/2/news?'+params,{signal:AbortSignal.timeout(30000)});status=r.status;limits=newsdataHeaders(r.headers);data=await r.json();
  const retry=number(r.headers.get('retry-after'));
  if(status===429||limits.rate_remaining!==null&&limits.rate_remaining<=2){const until=limits.rate_reset?limits.rate_reset*1000+2000:Date.now()+Math.max(60,retry||900)*1000;retryAt=new Date(Math.max(Date.now()+2000,until)).toISOString();}
 }catch{data={status:'error',error:'transport_or_timeout'};}
 const list=Array.isArray(data.results)?data.results:[],credits=status===0?null:status===200?1:0;
 // Never persist provider messages: they may include the credential-bearing URL.
 must(await rt.db.rpc('l_news_finish_newsdata_call',{p_usage:id,p_status:status,p_credits:credits,p_count:list.length,p_elapsed:Date.now()-started,p_details:{assistant_id:3,query_index:job.payload.query_index,query_kind:query.kind,total_hits:number(data.total_results),account_remaining:limits?.remaining??null},p_limits:limits,p_retry_at:retryAt}));
 if(status===429)return {retry_at:retryAt};
 if(status!==200)throw Error('newsdata_search_'+status);
 if(data.status!=='success'||!Array.isArray(data.results))throw Error('newsdata_invalid_response');
 const next=typeof data.next_page==='string'&&data.next_page!==cursor?data.next_page:null;
 return {candidates:list.map(newsdataCandidate),next_cursor:next,next:!!next,page:Number(job.payload.page||1),total:number(data.total_results)};
}
