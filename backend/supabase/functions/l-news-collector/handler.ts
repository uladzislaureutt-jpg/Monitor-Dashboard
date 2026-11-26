import {COUNTRY_NAMES,VERSION} from './core.ts';
import {Job,Runtime,must,readPages} from './providers.ts';
import {enqueue,workOne} from './worker.ts';
import {probe} from './probe.ts';
import {probeGdelt} from './gdelt.ts';
import {bundleForRun} from './bundle.ts';
import {warningRu} from './warnings.ts';
import {assistantId,probeAssistant2,providerJobLabel,validateAssistant2Settings} from './assistant2.ts';

const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization,apikey,content-type,x-client-info','Access-Control-Allow-Methods':'POST,OPTIONS'};
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{...cors,'content-type':'application/json'}});

export function createCollectorHandler(rt: Runtime) {
 const db = rt.db;
async function worker(){
 const jobs=must(await db.rpc('l_news_claim_jobs',{p_limit:1})) as Job[];const results=[];
 for(const job of jobs){try{
  const result=job.kind==='assistant2_probe'?await probeAssistant2(rt):job.kind==='probe'?await probe(rt,job):job.kind==='gdelt_probe'?await probeGdelt(rt,job):await workOne(rt,job);
  const retryAt=result.retry_at;
  const patch=retryAt
   ?{state:'waiting',available_at:retryAt,attempts:job.attempts-1}
   :{state:'done',result};
  must(await db.from('l_news_jobs').update({...patch,lease_until:null,updated_at:new Date().toISOString()}).eq('id',job.id));
  results.push({id:job.id,state:patch.state});
 }catch(error){
  const message=error instanceof Error?error.message:'worker_error';
  const retry=job.kind!=='gdelt_probe'&&job.attempts<4&&/translation_unavailable|relevance_review_unavailable|transport|timeout|search_0$|(?:search|subscription)_(?:429|50[0234])$/.test(message);
  must(await db.from('l_news_jobs').update({state:retry?'waiting':'failed',error:message.slice(0,350),available_at:new Date(Date.now()+60000*job.attempts*job.attempts).toISOString(),lease_until:null,updated_at:new Date().toISOString()}).eq('id',job.id));
  if(!retry&&job.kind==='article')must(await db.from('l_news_items').update({state:'failed',reason:message.slice(0,250)}).eq('id',job.payload.item_id).neq('state','ready'));
  results.push({id:job.id,state:retry?'retry':'failed',error:message});
 }
 if(job.run_id){const counts=must(await db.rpc('l_news_refresh_run',{p_run:job.run_id}));if(counts.jobs_pending===0){const run=must(await db.from('l_news_runs').select('assistant_id').eq('id',job.run_id).single());await enqueue(rt,null,run.assistant_id===2?'assistant2_probe':'probe',{pages:[]},job.run_id+':quota-final');}}
 }
 if(jobs.length)must(await db.rpc('l_news_wake'));
 return results;
}

async function status(assistant:number,terminalId?:string){
 const now=Date.now(), dayMs=86400000;
 const [settings,runs,providers,sources,usage]=await Promise.all([
  db.from(assistant===2?'l_news_assistant2_settings':'l_news_settings').select('*').single(),
  db.from('l_news_runs').select('id,number,assistant_id,assistant_number,status,from_at,to_at,settings,counters,warnings,revision,created_at,completed_at').eq('assistant_id',assistant).order('created_at',{ascending:false}).limit(5),
  db.from('l_news_provider_state').select('*'),
  readPages(db.from('l_news_sources').select('country,baseline,coverage').eq('enabled',true).order('domain')),
  readPages<{provider:string;endpoint:string;status:number|null;credits:number|string|null;created_at:string;billable?:boolean}>(
   db.from('l_news_usage').select('provider,endpoint,billable,status,credits,created_at')
    .gte('created_at',new Date(now-32*dayMs).toISOString()).order('id'))
 ]);
 const newscatcher_usage={days:30,credits:0,assistant:0,event:0,diagnostic:0,unconfirmed:0};
 for(const row of usage){
  if(row.provider!=='newscatcher'||Date.parse(row.created_at)<now-newscatcher_usage.days*dayMs)continue;
  if(row.credits===null){newscatcher_usage.unconfirmed++;continue;}
  const credits=Number(row.credits);
  newscatcher_usage.credits+=credits;
  const category=row.endpoint==='event_articles'?'event':row.endpoint==='articles'?'assistant':'diagnostic';
  newscatcher_usage[category]+=credits;
 }
 const diagnostic_usage={days:30,cloro_credits:0,currents_requests:0,thenews_requests:0};
 for(const row of usage){
  if(Date.parse(row.created_at)<now-30*dayMs||!row.endpoint.startsWith('assistant2_'))continue;
  if(row.provider==='cloro')diagnostic_usage.cloro_credits+=Number(row.credits??0);
  if(row.billable!==false&&row.provider==='currents')diagnostic_usage.currents_requests++;
  if(row.billable!==false&&row.provider==='thenews')diagnostic_usage.thenews_requests++;
 }
 const localizedRuns=(must(runs) as any[]).map(run=>({
   ...run,warnings:Array.isArray(run.warnings)?run.warnings.map(warningRu):[]
  }));
 const selected=localizedRuns.find(run=>run.id===terminalId)||localizedRuns[0];
 const terminal=selected?must(await db.from('l_news_jobs').select('id,kind,state,attempts,updated_at,error,result').eq('run_id',selected.id).order('updated_at',{ascending:false}).limit(80)):[];
 const usage_limits=assistant===2?must(await db.rpc('l_news_assistant2_usage')):null;
 return {version:VERSION,assistant_id:assistant,country_names:COUNTRY_NAMES,settings:must(settings),runs:localizedRuns,providers:must(providers),sources,newscatcher_usage,diagnostic_usage,usage_limits,
  terminal_run_id:selected?.id??null,terminal:terminal.map((row:any)=>({id:row.id,kind:row.kind,label:providerJobLabel(row.kind),state:row.state,attempts:row.attempts,at:row.updated_at,error:row.error?warningRu(row.error):null,returned:row.result?.returned??row.result?.result_count??null,kept:row.result?.kept??null,new_to_index:row.result?.new_to_index??null,ready:row.result?.ready??false,capped:row.result?.capped??false}))};
}
return async (req: Request): Promise<Response> => {try{
 if(req.method==='OPTIONS')return new Response(null,{status:204,headers:cors});if(req.method!=='POST')return json({error:'method_not_allowed'},405);
 const text=await req.text();if(text.length>2000000)return json({error:'request_too_large'},413);let body:any;try{body=JSON.parse(text||'{}');}catch{return json({error:'invalid_json'},400);}
 const action=String(body.action||'status'),workerToken=req.headers.get('x-l-news-worker');
 const assistant=body.assistant_id===undefined?1:Number(body.assistant_id);if(![1,2].includes(assistant))return json({error:'invalid_assistant'},400);
 if(workerToken){const verified=must(await db.rpc('l_news_verify_worker',{p_token:workerToken}));if(!verified)return json({error:'unauthorized'},401);if(action!=='worker')return json({error:'worker_only'},403);return json({results:await worker()});}
 const token=(req.headers.get('authorization')||'').replace(/^Bearer\s+/i,'');if(!token)return json({error:'unauthorized'},401);
 const user=await db.auth.getUser(token);if(user.error||!user.data.user)return json({error:'unauthorized'},401);
 const profile=must(await db.from('monitor_profiles').select('id,is_admin,status').eq('id',user.data.user.id).maybeSingle());if(!profile||profile.status!=='active')return json({error:'access_denied'},403);
 if(!profile.is_admin){const [global,personal]=await Promise.all([db.from('monitor_access').select('enabled').eq('monitor_key','lukashenko').maybeSingle(),db.from('user_monitor_access').select('enabled').eq('monitor_key','lukashenko').eq('user_id',user.data.user.id).maybeSingle()]);if(global.error||personal.error||!global.data?.enabled||!personal.data?.enabled)return json({error:'access_denied'},403);}
 if(action==='status')return json(await status(assistant,body.terminal_run_id));
 if(action==='manifest')return json({runs:must(await db.from('l_news_runs').select('id,number,status,revision,to_at,counters').order('created_at',{ascending:false}).limit(500))});
 if(action==='download')return json(await bundleForRun(rt,String(body.run_id||'')));
 if(!profile.is_admin)return json({error:'admin_required'},403);
 if(action==='start'){
  const requested=body.countries;
  if(requested!==undefined&&(!Array.isArray(requested)||requested.length===0||requested.some(code=>typeof code!=='string'||!/^[A-Z]{2}$/.test(code))))return json({error:'invalid_countries'},400);
  const countries=requested===undefined?null:[...new Set(requested)];
  const result=assistant===2?await db.rpc('l_news_enqueue_assistant2_run',{p_trigger:'manual',p_countries:countries}):countries===null?await db.rpc('l_news_enqueue_run',{p_trigger:'manual'}):
   await db.rpc('l_news_enqueue_scoped_run',{p_trigger:'manual',p_countries:countries});
  if(result.error?.code==='PGRST202')return json({error:'Выбор стран пока не подключён на сервере'},503);
  if(result.error?.code==='22023')return json({error:'invalid_countries'},400);
  const id=must(result);
  must(await db.rpc('l_news_wake'));return json({run_id:id});
 }
 if(action==='settings'){
  if(assistant===2){
   let patch;try{const catalog=await readPages<{country:string}>(db.from('l_news_sources').select('country').eq('enabled',true).order('domain'));patch=validateAssistant2Settings(body,[...new Set(catalog.map(x=>x.country))]);}catch(error){return json({error:error instanceof Error?error.message:'invalid_settings'},400);}
   must(await db.from('l_news_assistant2_settings').update(patch).eq('id',true));return json({ok:true});
  }
  const patch:any={updated_at:new Date().toISOString()};
  if(typeof body.enabled==='boolean')patch.enabled=body.enabled;
  if(body.lookback_hours!==undefined){const hours=Number(body.lookback_hours);if(!Number.isInteger(hours)||hours<1||hours>168)return json({error:'invalid_lookback'},400);patch.lookback_hours=hours;}
  must(await db.from('l_news_settings').update(patch).eq('id',true));return json({ok:true});
 }
 if(action==='quota'){await enqueue(rt,null,assistant===2?'assistant2_probe':'probe',{pages:[]},'quota-refresh:'+assistant+':'+crypto.randomUUID());must(await db.rpc('l_news_wake'));return json({queued:true});}
 if(action==='cancel'){
  const run=must(await db.from('l_news_runs').select('id,assistant_id').eq('id',String(body.run_id||'')).maybeSingle());
  if(!run||run.assistant_id!==assistant)return json({error:'invalid_run'},400);
  must(await db.from('l_news_runs').update({status:'cancelled',completed_at:new Date().toISOString()}).eq('id',run.id));
  must(await db.from('l_news_jobs').update({state:'done',result:{cancelled:true}}).eq('run_id',run.id).eq('state','waiting'));
  return json({ok:true});
 }
 if(action==='retry_failed'){
  const runs=must(await db.from('l_news_runs').select('id').eq('assistant_id',assistant).order('created_at',{ascending:false}).limit(5));
  if(!runs.length)return json({retried:0});
  const jobs=must(await db.from('l_news_jobs').select('id,payload,run_id').eq('kind','article').eq('state','failed').in('run_id',runs.map((r:any)=>r.id)).limit(100));
  for(const job of jobs){must(await db.from('l_news_jobs').update({state:'waiting',attempts:0,error:null,available_at:new Date().toISOString()}).eq('id',job.id));must(await db.from('l_news_items').update({state:'pending'}).eq('id',job.payload.item_id).eq('state','failed'));}
  must(await db.rpc('l_news_wake'));return json({retried:jobs.length});
 }
 return json({error:'unknown_action'},400);
 }catch(error){console.error('l_news_error',error instanceof Error?error.message.slice(0,300):'unknown');return json({error:'collector_error'},500);}};
}
