import {QUERY,VERSION} from './core.ts';
import {Job,Runtime,must,newscatcherSubscription,perigonLimits,reserve} from './providers.ts';

export async function probe(rt:Runtime,job:Job){
 const result:any={version:VERSION,configured:{perigon:!!rt.perigonKey,newscatcher:!!rt.newscatcherKey}};
 if(rt.perigonKey){
  const before:any=await perigonLimits(rt);result.perigon={before,pages:[]};
  const pages=Array.isArray(job.payload.pages)?job.payload.pages.map(Number).filter((p:number)=>p>=0&&p<3).slice(0,2):[];
  for(const page of pages){
   if(Number(before.requestsUsed)+result.perigon.pages.length>=Math.min(150,Number(before.requestLimit)))break;
   const id=await reserve(rt,job,null,'perigon','articles_probe',page,2,150);if(!id)break;
   const to=new Date(),from=new Date(to.getTime()-26*3600000),q=new URLSearchParams({q:QUERY,searchTranslation:'true',from:from.toISOString(),to:to.toISOString(),sortBy:'date',showReprints:'true',page:String(page),size:'1'});
   const start=Date.now();let status=0,payload:any={};
   try{const response=await fetch('https://api.perigon.io/v1/all?'+q,{headers:{'x-api-key':rt.perigonKey},signal:AbortSignal.timeout(25000)});status=response.status;payload=await response.json().catch(()=>({}));}catch{/* reserve remains conservative */}
   const usage:any=await perigonLimits(rt);const articles=payload.articles||[];
   const detail={page,status,numResults:payload.numResults??null,returned:articles.length,content_lengths:articles.map((a:any)=>String(a.content||'').length),requestsUsed:usage.requestsUsed};
   must(await rt.db.from('l_news_usage').update({status,result_count:articles.length,elapsed_ms:Date.now()-start,details:{probe:true,limits_after:usage}}).eq('id',id));result.perigon.pages.push(detail);if(status!==200)break;
  }
  const after:any=await perigonLimits(rt);result.perigon.after=after;result.perigon.measured_billable_delta=Number(after.requestsUsed)-Number(before.requestsUsed);
 }
 if(rt.newscatcherKey&&!job.payload.skip_newscatcher)result.newscatcher=await newscatcherSubscription(rt);
 return result;
}
