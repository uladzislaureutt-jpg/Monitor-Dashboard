import {createClient} from 'npm:@supabase/supabase-js@2.98.0';
// One diagnostic call per pre-authorized ledger row. No writes to cards or settings.
const GATE='__DIAGNOSTIC_GATE__';
const EXPIRES='2026-11-26T12:00:00Z';
const ENDPOINT='assistant2_recheck_20261126';
const env=Deno.env.toObject();
function secret(...names:string[]){for(const n of names){const k=Object.keys(env).find(k=>k.toLowerCase()===n.toLowerCase());if(k&&env[k])return {name:k,value:env[k]};}return {name:null,value:''};}
const keys={newscatcher:secret('NEWSCATCHER_API_KEY','NEWS_CATCHER_API_KEY'),thenews:secret('THENEWSAPI_API_KEY','THE_NEWS_API_KEY'),currents:secret('CURRENTSAPI_API_KEY'),cloro:secret('CLORO_API_KEY')};
const db=createClient(secret('SUPABASE_URL').value,secret('SUPABASE_SERVICE_ROLE_KEY').value,{auth:{persistSession:false}});
const from='2026-11-24T12:00:00Z',to='2026-11-26T03:30:00Z';
const json=(o:unknown,status=200)=>new Response(JSON.stringify(o),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});
function redact(value:unknown):any{if(typeof value==='string'){let s=value;for(const k of Object.values(keys))if(k.value)s=s.split(k.value).join('[REDACTED]');return s.slice(0,1200);}if(Array.isArray(value))return value.map(redact);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!/(token|api.?key|authorization)/i.test(k)).map(([k,v])=>[k,redact(v)]));return value;}
function entries(value:any):any[]{for(const p of [value?.results,value?.articles,value?.data,value?.news,value?.newsResults,value?.result?.newsResults,value?.response?.result?.newsResults,value?.response?.newsResults])if(Array.isArray(p))return p;return [];}
function articles(value:any){return entries(value).slice(0,100).map(a=>({url:a.url||a.link,title:String(a.title||a.headline||'').slice(0,400),description:String(a.description||a.snippet||a.summary||'').slice(0,700),published:a.published_at||a.published_date||a.published||null,date_raw:a.date||null,language:a.language||null,source:a.source||null,position:a.position||null,content_chars:String(a.content||'').length}));}
Deno.serve(async req=>{
 if(Date.now()>Date.parse(EXPIRES))return json({error:'expired'},410);
 if(req.method!=='POST'||req.headers.get('authorization')!=='Bearer '+GATE)return json({error:'unauthorized'},401);
 let input:any;try{input=await req.json();}catch{return json({error:'invalid_json'},400);}
 if(input.action==='config')return json({configured:Object.fromEntries(Object.entries(keys).map(([k,v])=>[k,{present:!!v.value,matched_name:v.name}])),expires:EXPIRES});
 const usageId=Number(input.usage_id);if(!Number.isInteger(usageId))return json({error:'usage_id_required'},400);
 const claim=await db.from('l_news_usage').update({status:-101}).eq('id',usageId).eq('status',-100).eq('endpoint',ENDPOINT).select('id,provider,page,details').maybeSingle();
 if(claim.error||!claim.data)return json({error:'not_authorized_or_already_used'},409);
 const row=claim.data,d=row.details||{},provider=row.provider,p=d.language||'en',q=d.query||'Lukashenko';
 let url='',options:RequestInit={},body:any={},response:Response|undefined,error:any=null;const started=Date.now();
 try{
  const type=String(d.type||'search');
  if(provider==='newscatcher'&&type==='schema'){url='https://api.newscatcherapi.com/news-api/openapi.json';}
  else if(provider==='newscatcher'&&type==='quota'){url='https://api.newscatcherapi.com/news-api/subscription';options={headers:{'x-api-key':keys.newscatcher.value}};}
  else if(provider==='cloro'&&type==='quota'){url='https://api.cloro.dev/v1/credits';options={headers:{Authorization:'Bearer '+keys.cloro.value}};}
  else if(provider==='newscatcher'){
   const slot=await db.rpc('l_news_newscatcher_rate_slot');if(slot.error)throw new Error('rate_slot_failed');const ms=Number(slot.data)||0;if(ms>0)await new Promise(r=>setTimeout(r,Math.min(ms,15000)));
   url='https://api.newscatcherapi.com/news-api/articles';options={method:'POST',headers:{'content-type':'application/json','x-api-key':keys.newscatcher.value},body:JSON.stringify({q,search_in:d.search_in||['title_body'],languages:p==='all'?undefined:[p],sources:d.sources,from_date:from,to_date:to,page_size:100,page:Math.max(1,Math.min(2,row.page||1)),sort_by:'published_at',exclude_duplicates:false})};
  }else if(provider==='thenews'){
   const u=new URL('https://api.thenewsapi.com/v1/news/all');for(const [k,v] of Object.entries({api_token:keys.thenews.value,search:q,language:p,limit:'3',page:String(Math.max(1,Math.min(4,row.page||1))),published_after:from.replace('Z',''),published_before:to.replace('Z',''),sort:'published_at'}))u.searchParams.set(k,v);url=u.href;
  }else if(provider==='currents'){
   const u=new URL('https://api.currentsapi.services/v1/search');for(const [k,v] of Object.entries({keywords:q,language:p,page_size:'20',page_number:String(Math.max(1,Math.min(3,row.page||1))),start_date:from,end_date:to,type:'1'}))u.searchParams.set(k,v);url=u.href;options={headers:{Authorization:'Bearer '+keys.currents.value}};
  }else if(provider==='cloro'&&type==='async'){
   url='https://api.cloro.dev/v1/async/task';options={method:'POST',headers:{Authorization:'Bearer '+keys.cloro.value,'content-type':'application/json'},body:JSON.stringify({taskType:'GOOGLE_NEWS',idempotencyKey:ENDPOINT+'-'+usageId,payload:{query:q+' after:2026-11-24 before:2026-11-27',country:d.country,hl:p,gl:String(d.country).toLowerCase(),pages:1,include:{html:false}}})};
  }else if(provider==='cloro'&&type==='poll'&&/^[0-9a-f-]{36}$/.test(d.task_id)){
   url='https://api.cloro.dev/v1/async/task/'+d.task_id;options={headers:{Authorization:'Bearer '+keys.cloro.value}};
  }else throw new Error('unsupported_diagnostic');
  response=await fetch(url,{...options,signal:AbortSignal.timeout(45000)});body=await response.json().catch(()=>({error:'invalid_json'}));
 }catch(e){error=String(e?.name||'transport_error');}
 if(d.type==='schema'){const schema=body.paths?.['/articles']?.post?.requestBody?.content?.['application/json']?.schema;const ref=schema?.$ref?.split('/').pop();body={request_schema:ref?body.components?.schemas?.[ref]:schema};}
 const list=articles(body),safe=redact({usage_id:usageId,provider,query:q,language:p,page:row.page,status:response?.status||0,elapsed_ms:Date.now()-started,error,meta:body?.meta||null,total_hits:body?.total_hits??null,total_pages:body?.total_pages??null,articles:list,task:body?.task||null,credits:body?.credits||null,response_error:body?.error||body?.detail||null,quota:['quota','schema'].includes(d.type)?body:null,headers:response?Object.fromEntries([...response.headers].filter(([k])=>/^(x-credits-|x-ratelimit-|x-usage|x-requests|retry-after)/i.test(k))):{}});
 const charged=provider==='newscatcher'&&d.type==='search'&&response?.ok?5:provider==='cloro'&&d.type==='poll'?Number(body?.credits?.creditsCharged||0):0;
 await db.from('l_news_usage').update({status:response?.status||0,result_count:list.length,elapsed_ms:Date.now()-started,credits:charged,details:{...d,diagnostic:'assistant2_recheck',meta:safe.meta,headers:safe.headers,task:safe.task,credits:safe.credits,response_error:safe.response_error,transport_error:error}}).eq('id',usageId);
 return json(safe);
});
