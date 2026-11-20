import {COUNTRY_NAMES,VERSION} from './core.ts';
import {Job,Runtime,must} from './providers.ts';
import {enqueue,workOne} from './worker.ts';
import {probe} from './probe.ts';
import {bundleForRun} from './bundle.ts';

const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization,apikey,content-type,x-client-info','Access-Control-Allow-Methods':'POST,OPTIONS'};
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{...cors,'content-type':'application/json'}});

export function createCollectorHandler(rt: Runtime) {
 const db = rt.db;
async function worker(){
 const jobs=must(await db.rpc('l_news_claim_jobs',{p_limit:1})) as Job[];const results=[];
 for(const job of jobs){try{
  const result=job.kind==='probe'?await probe(rt,job):await workOne(rt,job);
  must(await db.from('l_news_jobs').update({state:'done',result,lease_until:null,updated_at:new Date().toISOString()}).eq('id',job.id));results.push({id:job.id,state:'done'});
 }catch(error){
  const message=error instanceof Error?error.message:'worker_error';
  const retry=job.attempts<4&&/translation_unavailable|transport|timeout|search_0$|search_429$|search_50[0234]$/.test(message);
  must(await db.from('l_news_jobs').update({state:retry?'waiting':'failed',error:message.slice(0,350),available_at:new Date(Date.now()+60000*job.attempts*job.attempts).toISOString(),lease_until:null,updated_at:new Date().toISOString()}).eq('id',job.id));
  if(!retry&&job.kind==='article')must(await db.from('l_news_items').update({state:'failed',reason:message.slice(0,250)}).eq('id',job.payload.item_id).neq('state','ready'));
  results.push({id:job.id,state:retry?'retry':'failed',error:message});
 }
 if(job.run_id){const counts=must(await db.rpc('l_news_refresh_run',{p_run:job.run_id}));if(counts.jobs_pending===0)await enqueue(rt,null,'probe',{pages:[]},job.run_id+':quota-final');}
 }
 if(jobs.length)must(await db.rpc('l_news_wake'));
 return results;
}

async function status(){
 const [settings,runs,providers,sources,usage]=await Promise.all([
  db.from('l_news_settings').select('*').single(),
  db.from('l_news_runs').select('id,number,status,from_at,to_at,settings,counters,warnings,revision,created_at,completed_at').order('created_at',{ascending:false}).limit(30),
  db.from('l_news_provider_state').select('*'),
  db.from('l_news_sources').select('country,baseline,coverage').eq('enabled',true),
  db.from('l_news_usage').select('provider,billable,status,credits,created_at').gte('created_at',new Date(Date.now()-32*86400000).toISOString())
 ]);
 return {version:VERSION,country_names:COUNTRY_NAMES,settings:must(settings),runs:must(runs),providers:must(providers),sources:must(sources),usage:must(usage)};
}
return async (req: Request): Promise<Response> => {try{
 if(req.method==='OPTIONS')return new Response(null,{status:204,headers:cors});if(req.method!=='POST')return json({error:'method_not_allowed'},405);
 const text=await req.text();if(text.length>2000000)return json({error:'request_too_large'},413);let body:any;try{body=JSON.parse(text||'{}');}catch{return json({error:'invalid_json'},400);}
 const action=String(body.action||'status'),workerToken=req.headers.get('x-l-news-worker');
 if(workerToken){const verified=must(await db.rpc('l_news_verify_worker',{p_token:workerToken}));if(!verified)return json({error:'unauthorized'},401);if(action!=='worker')return json({error:'worker_only'},403);return json({results:await worker()});}
 const token=(req.headers.get('authorization')||'').replace(/^Bearer\s+/i,'');if(!token)return json({error:'unauthorized'},401);
 const user=await db.auth.getUser(token);if(user.error||!user.data.user)return json({error:'unauthorized'},401);
 const profile=must(await db.from('monitor_profiles').select('id,is_admin,status').eq('id',user.data.user.id).maybeSingle());if(!profile||profile.status!=='active')return json({error:'access_denied'},403);
 if(!profile.is_admin){const [global,personal]=await Promise.all([db.from('monitor_access').select('enabled').eq('monitor_key','lukashenko').maybeSingle(),db.from('user_monitor_access').select('enabled').eq('monitor_key','lukashenko').eq('user_id',user.data.user.id).maybeSingle()]);if(global.error||personal.error||!global.data?.enabled||!personal.data?.enabled)return json({error:'access_denied'},403);}
 if(action==='status')return json(await status());
 if(action==='manifest')return json({runs:must(await db.from('l_news_runs').select('id,number,status,revision,to_at,counters').order('created_at',{ascending:false}).limit(500))});
 if(action==='download')return json(await bundleForRun(rt,String(body.run_id||'')));
 if(!profile.is_admin)return json({error:'admin_required'},403);
 if(action==='start'){
  const requested=body.countries;
  if(requested!==undefined&&(!Array.isArray(requested)||requested.length===0||requested.some(code=>typeof code!=='string'||!Object.hasOwn(COUNTRY_NAMES,code))))return json({error:'invalid_countries'},400);
  const countries=requested===undefined?null:[...new Set(requested)];
  const result=countries===null?await db.rpc('l_news_enqueue_run',{p_trigger:'manual'}):
   await db.rpc('l_news_enqueue_scoped_run',{p_trigger:'manual',p_countries:countries});
  if(result.error?.code==='PGRST202')return json({error:'Выбор стран пока не подключён на сервере'},503);
  if(result.error?.code==='22023')return json({error:'invalid_countries'},400);
  const id=must(result);
  must(await db.rpc('l_news_wake'));return json({run_id:id});
 }
 if(action==='settings'){
  const patch:any={updated_at:new Date().toISOString()};
  if(typeof body.enabled==='boolean')patch.enabled=body.enabled;
  if(body.lookback_hours!==undefined){const hours=Number(body.lookback_hours);if(!Number.isInteger(hours)||hours<1||hours>168)return json({error:'invalid_lookback'},400);patch.lookback_hours=hours;}
  must(await db.from('l_news_settings').update(patch).eq('id',true));return json({ok:true});
 }
 if(action==='quota'){await enqueue(rt,null,'probe',{pages:[]},'quota-refresh:'+crypto.randomUUID());must(await db.rpc('l_news_wake'));return json({queued:true});}
 if(action==='retry_failed'){
  const jobs=must(await db.from('l_news_jobs').select('id,payload,run_id').eq('kind','article').eq('state','failed').limit(100));
  for(const job of jobs){must(await db.from('l_news_jobs').update({state:'waiting',attempts:0,error:null,available_at:new Date().toISOString()}).eq('id',job.id));must(await db.from('l_news_items').update({state:'pending'}).eq('id',job.payload.item_id).eq('state','failed'));}
  must(await db.rpc('l_news_wake'));return json({retried:jobs.length});
 }
 return json({error:'unknown_action'},400);
 }catch(error){console.error('l_news_error',error instanceof Error?error.message.slice(0,300):'unknown');return json({error:'collector_error'},500);}};
}
