import { clean, domainOf } from './core.ts';
import type { Candidate } from './core.ts';
import { must } from './providers.ts';
import type { Job, Run, Runtime } from './providers.ts';

export function retryAfterAt(header:string|null, now:number):string|null {
 if(!header?.trim())return null;
 const value=header.trim();
 const date=new Date(/^\d+$/.test(value)?now+Number(value)*1000:Date.parse(value));
 return Number.isFinite(date.getTime())&&date.getTime()>=now?date.toISOString():null;
}

type GdeltReservation={
 usage_id?:number;
 already_reserved?:true;
 blocked_until?:string;
 retry_at?:string;
};

async function gdeltReservation(rt:Runtime,job:Job,run?:Run):Promise<GdeltReservation>{
 return must(await rt.db.rpc('l_news_reserve_gdelt',{
  p_run:run?.id??null,p_job:job.id,p_endpoint:run?'doc':'doc_probe',p_run_limit:run?.settings.gdelt_per_run??0,
 }));
}

async function fetchGdelt(rt:Runtime, id:number, from:string, to:string) {
 const stamp=(value:string)=>new Date(value).toISOString().replace(/[-:T]/g,'').slice(0,14);
 const query=new URLSearchParams({
  query:'(Lukashenko OR Lukashenka) -sourcecountry:belarus',mode:'artlist',format:'json',
  startdatetime:stamp(from),enddatetime:stamp(to),maxrecords:'250',sort:'datedesc',
 });
 const start=Date.now();
 let status=0,raw='',error:string|null=null,contentType:string|null=null,retryAfter:string|null=null;
 let success=false;
 try{
  const response=await fetch('https://api.gdeltproject.org/api/v2/doc/doc?'+query,{
   redirect:'error',signal:AbortSignal.timeout(25000),
  });
  status=response.status;
  contentType=response.headers.get('content-type');
  retryAfter=response.headers.get('retry-after');
  raw=await response.text();
  success=response.ok;
 }catch(reason){
  error=reason instanceof Error?clean(reason.message).slice(0,260):'transport_error';
 }
 let data:any=null;
 try{data=JSON.parse(raw);}catch{/* GDELT can send plain text for an HTTP 200. */}
 const articles=Array.isArray(data?.articles)?data.articles:null;
 const details={
  content_type:contentType,retry_after:retryAfter,body_excerpt:clean(raw).slice(0,260)||null,
  transport_error:error,valid_articles:articles!==null,
 };
 const blockedUntil:string|null=must(await rt.db.rpc('l_news_finish_gdelt',{
  p_id:id,p_status:status,p_result_count:articles?.length??0,p_elapsed_ms:Date.now()-start,
  p_details:details,p_retry_after_at:retryAfterAt(retryAfter,Date.now()),
 }));
 return {status,success,articles,details,blocked_until:blockedUntil};
}

export async function probeGdelt(rt:Runtime,job:Job){
 const from=new Date(job.payload.from).toISOString(),to=new Date(job.payload.to).toISOString();
 const reservation=await gdeltReservation(rt,job);
 if(!reservation.usage_id)return reservation;
 const result=await fetchGdelt(rt,reservation.usage_id,from,to);
 return {status:result.status,returned:result.articles?.length??0,...result.details,blocked_until:result.blocked_until};
}

function blockedWarning(until:string){
 const local=new Date(until).toLocaleString('ru-RU',{timeZone:'Europe/Minsk'});
 return {warnings:[`GDELT: HTTP 429, обращения приостановлены до ${local} по Минску.`]};
}

export async function searchGdelt(rt:Runtime,job:Job,run:Run){
 const reservation=await gdeltReservation(rt,job,run);
 if(reservation.blocked_until)return blockedWarning(reservation.blocked_until);
 if(reservation.retry_at)return {retry_at:reservation.retry_at};
 if(!reservation.usage_id)return {capped:true};

 const from=job.payload.from||run.from_at,to=job.payload.to||run.to_at;
 const result=await fetchGdelt(rt,reservation.usage_id,from,to);
 if(result.status===429)return blockedWarning(result.blocked_until!);
 if(!result.success)throw new Error('gdelt_search_'+result.status);
 if(!result.articles)throw new Error('gdelt_transport_invalid_response_'+(result.details.body_excerpt||'empty'));
 const articles=result.articles;
 return {candidates:articles.map((a:any):Candidate=>({
  url:a.url,title:clean(a.title),lead:'',body:'',published_at:null,language:String(a.language||'').toLowerCase(),
  country:'',domain:domainOf(a.url),provider:'gdelt',provider_id:a.url,image:a.socialimage,
 })),split:articles.length>=250&&Date.parse(to)-Date.parse(from)>3600000,from,to};
}
