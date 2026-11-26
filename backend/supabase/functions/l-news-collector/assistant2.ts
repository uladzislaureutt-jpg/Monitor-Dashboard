import {Candidate,clean,domainOf} from './core.ts';
import {Job,Run,Runtime,must,reserve,saveState,newscatcherSubscription} from './providers.ts';
import {DISCOVERY_LANGUAGES} from './discovery.ts';
export {currentsPlans,searchCurrents} from './discovery.ts';

export const assistantId=(run:Run)=>Number(run.assistant_id??run.settings.assistant_id??1);
const ACTIVE_LANGUAGES=Object.keys(DISCOVERY_LANGUAGES);
const COUNTRY_LANGUAGE:Record<string,string>={PL:'pl',UA:'uk',RU:'ru',DE:'de',AT:'de',CH:'de',FR:'fr',BE:'fr',US:'en',GB:'en',CA:'en',IT:'it',ES:'es',BR:'pt',PT:'pt',TR:'tr',JP:'ja',CN:'zh',TW:'zh',KR:'ko',IR:'fa',IL:'he',GE:'ka',AM:'hy'};
const GOOGLE_QUERY:Record<string,string>={en:'(Lukashenko OR Lukashenka)',fr:'(Loukachenko OR Loukachenka)',de:'(Lukaschenko OR Lukaschenka)',pl:'(Łukaszenka OR Lukaszenka)',uk:'(Лукашенко OR Лукашенка)',ru:'(Лукашенко OR Лукашэнка)',it:'(Lukashenko OR Lukashenka)',es:'(Lukashenko OR Lukashenka)',pt:'(Lukashenko OR Lukashenka)',tr:'(Lukaşenko OR Lukashenko)',ja:'ルカシェンコ',zh:'(卢卡申科 OR 盧卡申科)',ko:'루카셴코',fa:'لوکاشنکو',he:'לוקשנקו',ka:'ლუკაშენკო',hy:'Լուկաշենկո'};

export function validateAssistant2Settings(body:Record<string,unknown>,countries:string[]){
 const patch:Record<string,unknown>={updated_at:new Date().toISOString()};
 const ranges:Record<string,[number,number]>={lookback_hours:[1,168],newscatcher_per_run:[0,100],newscatcher_daily_credits:[0,2000],newscatcher_monthly_credits:[0,20000],newscatcher_reserve:[0,10000],cloro_per_run:[0,20],cloro_daily_credits:[0,300],cloro_monthly_credits:[0,10000],cloro_reserve:[0,500],currents_per_run:[0,150],currents_pages_per_query:[1,10],thenews_per_run:[0,100],thenews_daily_requests:[0,100],thenews_monthly_requests:[0,3000],thenews_reserve:[0,100],thenews_pages_per_query:[1,10],currents_daily_requests:[0,250],currents_monthly_requests:[0,7500],currents_reserve:[0,100],candidate_limit:[10,3000],paid_extractions_per_run:[0,10]};
 for(const field of ['enabled','newscatcher_enabled','cloro_enabled','currents_enabled','thenews_enabled'])if(body[field]!==undefined){if(typeof body[field]!=='boolean')throw new Error('invalid_'+field);patch[field]=body[field];}
 for(const [field,[min,max]] of Object.entries(ranges))if(body[field]!==undefined){const n=Number(body[field]);if(typeof body[field]==='boolean'||!Number.isInteger(n)||n<min||n>max)throw new Error('invalid_'+field);patch[field]=n;}
 if(body.local_time!==undefined){if(typeof body.local_time!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(body.local_time))throw new Error('invalid_local_time');patch.local_time=body.local_time;}
 for(const field of ['countries','cloro_countries','currents_languages'])if(body[field]!==undefined){
  const list=body[field];const allowed=field==='currents_languages'?ACTIVE_LANGUAGES:countries;
  if(!Array.isArray(list)||list.length>100||list.some(x=>typeof x!=='string'||!allowed.includes(x))||(field==='countries'&&!list.length))throw new Error('invalid_'+field);
  patch[field]=[...new Set(list)];
 }
 return patch;
}

export function cloroCountries(run:Run):string[]{
 const eligible=(run.settings.cloro_countries as string[]).filter(c=>run.settings.countries.includes(c));
 const limit=Math.max(0,Number(run.settings.cloro_per_run)||0);
 const priority=['PL','UA','RU'].filter(c=>eligible.includes(c));
 const rest=eligible.filter(c=>!priority.includes(c));
 const offset=Math.max(0,Number(run.assistant_number??run.number)-1)%Math.max(1,rest.length);
 return [...priority,...rest.slice(offset),...rest.slice(0,offset)].slice(0,limit);
}
export async function probeAssistant2(rt:Runtime){
 const result:any={configured:{newscatcher:!!rt.newscatcherKey,cloro:!!rt.secret('CLORO_API_KEY'),currents:!!rt.secret('CURRENTSAPI_API_KEY'),thenews:!!rt.secret('THENEWSAPI_API_KEY','THE_NEWS_API_KEY')}};
 const warnings:string[]=[];
 if(rt.newscatcherKey)try{result.newscatcher=await newscatcherSubscription(rt);}catch{warnings.push('Newscatcher: не удалось проверить остаток');}
 const key=rt.secret('CLORO_API_KEY');
 if(key)try{
  const response=await fetch('https://api.cloro.dev/v1/credits',{headers:{Authorization:'Bearer '+key},signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new Error('quota_http');const value=await response.json();
  if(!Number.isFinite(Number(value.remaining)))throw new Error('quota_shape');
  const balance={remaining:Number(value.remaining),perCycle:value.perCycle??null,cycleResetsAt:value.cycleResetsAt??null};
  await saveState(rt,'cloro',{configured:true,balance});result.cloro=balance;
 }catch{warnings.push('Cloro: не удалось проверить остаток');}
 const cached=must(await rt.db.from('l_news_provider_state').select('*').eq('provider','currents').maybeSingle());
 result.currents={configured:result.configured.currents,limits:cached?.info?.limits??null,updated_at:cached?.updated_at??null,source:'last_search_headers'};
 const news=must(await rt.db.from('l_news_provider_state').select('*').eq('provider','thenews').maybeSingle());
 result.thenews={configured:result.configured.thenews,limits:news?.info?.limits??null,updated_at:news?.updated_at??null,source:'last_search_headers'};
 return {...result,warnings};
}

function cloroItems(body:any):any[]{for(const list of [body?.response?.result?.newsResults,body?.response?.newsResults,body?.response?.data?.newsResults,body?.response?.data?.result?.newsResults,body?.result?.newsResults])if(Array.isArray(list))return list;return [];}
export function cloroCandidates(body:any,country:string):Candidate[]{
 // Search-result relative dates are unreliable. Publication date is obtained
 // from the publisher by the shared extraction stage before admission.
 return cloroItems(body).map(a=>({url:String(a.link||a.url||''),title:clean(a.title),lead:clean(a.snippet||a.description),body:'',published_at:null,language:COUNTRY_LANGUAGE[country]||'en',country,domain:domainOf(a.link||a.url||''),provider:'cloro',provider_id:String(a.link||a.url||''),image:a.thumbnail}));
}
export async function submitCloro(rt:Runtime,job:Job,run:Run){
 const key=rt.secret('CLORO_API_KEY');if(!key)throw new Error('cloro_key_missing');
 const usage=await reserve(rt,job,run,'cloro','google_news_async',1,run.settings.cloro_per_run,0);if(!usage)return {capped:true,candidates:[]};
 const country=String(job.payload.country),language=COUNTRY_LANGUAGE[country]||'en';
 const from=new Date(Date.parse(run.from_at)-86400000).toISOString().slice(0,10),to=new Date(Date.parse(run.to_at)+86400000).toISOString().slice(0,10);
 const query=(GOOGLE_QUERY[language]||GOOGLE_QUERY.en)+' after:'+from+' before:'+to;
 const start=Date.now();let status=0,body:any={};
 try{const response=await fetch('https://api.cloro.dev/v1/async/task',{method:'POST',headers:{Authorization:'Bearer '+key,'content-type':'application/json'},body:JSON.stringify({taskType:'GOOGLE_NEWS',idempotencyKey:'l-news-assistant2:'+job.id,payload:{query,country,gl:country.toLowerCase(),hl:language,pages:1,include:{html:false}}}),signal:AbortSignal.timeout(20000)});status=response.status;body=await response.json().catch(()=>({}));}
 catch{/* Unknown outcome retains the 3-credit reservation and stable key. */}
 const taskId=body.task?.id||(status===409?body.error?.details?.taskId:null);
 // Retain the planned charge across retryable rejections: another job must
 // not spend this reservation while the same idempotent task is retried.
 const charge=taskId||status===0||[500,502,503,504].includes(status)||(status===429&&job.attempts<4)?3:0;
 must(await rt.db.from('l_news_usage').update({status,credits:charge,elapsed_ms:Date.now()-start,details:{assistant_id:2,country,task_id:taskId??null,reserved_units:charge}}).eq('id',usage));
 if(!taskId)throw new Error('cloro_search_'+status);
 return {task_id:taskId,usage_id:usage,country,started_at:new Date().toISOString(),warnings:[]};
}
export async function pollCloro(rt:Runtime,job:Job){
 const {task_id,usage_id,country,started_at}=job.payload;
 if(!/^[0-9a-f-]{36}$/i.test(String(task_id)))throw new Error('invalid_cloro_task');
 const response=await fetch('https://api.cloro.dev/v1/async/task/'+task_id,{headers:{Authorization:'Bearer '+rt.secret('CLORO_API_KEY')},signal:AbortSignal.timeout(20000)});
 if(!response.ok)throw new Error('cloro_search_'+response.status);const body=await response.json();
 const state=body.task?.status;
 if(!['COMPLETED','FAILED'].includes(state)){
  if(Date.now()-Date.parse(started_at)>600000)return {candidates:[],warnings:['Cloro: задача не завершилась за 10 минут; расход зарезервирован до уточнения.']};
  return {retry_at:new Date(Date.now()+20000).toISOString(),candidates:[]};
 }
 const candidates=state==='COMPLETED'?cloroCandidates(body,country):[];
 const credits=Number(body.credits?.creditsCharged??(state==='COMPLETED'?3:0));
 must(await rt.db.from('l_news_usage').update({status:state==='COMPLETED'?200:502,credits,result_count:candidates.length,details:{assistant_id:2,country,task_id,state,credits_confirmed:body.credits?.creditsCharged!=null}}).eq('id',usage_id));
 return {candidates,warnings:state==='FAILED'?['Cloro: поисковая задача завершилась ошибкой.']:[]};
}
export const providerJobLabel=(kind:string)=>({setup:'Подготовка источников',newscatcher:'Newscatcher',cloro:'Cloro: постановка поиска',cloro_poll:'Cloro: получение результатов',currents:'Currents',thenews:'The News API',perigon:'Perigon',article:'Проверка, текст и перевод',probe:'Проверка остатков',assistant2_probe:'Проверка остатков помощника 2',github_index:'Сверка общего индекса'} as Record<string,string>)[kind]||kind;
