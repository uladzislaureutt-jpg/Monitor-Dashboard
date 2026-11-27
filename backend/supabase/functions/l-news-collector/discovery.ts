import {Candidate,NAMES,Source,batches,clean,domainOf} from './core.ts';
import {Job,Run,Runtime,must,reserve,saveState} from './providers.ts';

// All 34 provider-supported codes; enabled defaults cover our current catalog.
export const DISCOVERY_LANGUAGES:Record<string,{label:string;countries:string[]}>= {
 en:{label:'Английский',countries:['*']},ru:{label:'Русский',countries:['RU','UA','KZ','KG','GE','AM','LT','LV','EE','PL','DE','GB','US','CA']},uk:{label:'Украинский',countries:['UA']},pl:{label:'Польский',countries:['PL']},de:{label:'Немецкий',countries:['DE','AT','CH']},fr:{label:'Французский',countries:['FR','BE','CH','CA','MA','DZ']},it:{label:'Итальянский',countries:['IT','CH','VA']},es:{label:'Испанский',countries:['ES','MX','CU','US','GQ']},pt:{label:'Португальский',countries:['PT','BR']},tr:{label:'Турецкий',countries:['TR']},zh:{label:'Китайский',countries:['CN','TW']},ja:{label:'Японский',countries:['JP']},ko:{label:'Корейский',countries:['KR']},ar:{label:'Арабский',countries:['QA','AE','SA','OM','JO','EG','DZ','MA','LY','LB']},he:{label:'Иврит',countries:['IL']},cs:{label:'Чешский',countries:['CZ']},ro:{label:'Румынский',countries:['RO','MD']},nl:{label:'Нидерландский',countries:['NL','BE']},sv:{label:'Шведский',countries:['SE','FI']},fi:{label:'Финский',countries:['FI']},hu:{label:'Венгерский',countries:['HU']},sr:{label:'Сербский',countries:['RS']},lt:{label:'Литовский',countries:['LT']},da:{label:'Датский',countries:['DK']},no:{label:'Норвежский',countries:['NO']},el:{label:'Греческий',countries:['GR']},hi:{label:'Хинди',countries:['IN']},ur:{label:'Урду',countries:['PK']},vi:{label:'Вьетнамский',countries:['VN']},ca:{label:'Каталанский',countries:['ES']},hr:{label:'Хорватский',countries:['HR']},id:{label:'Индонезийский',countries:['ID']},ms:{label:'Малайский',countries:['MY']},th:{label:'Тайский',countries:['TH']},
};
// Keep stemming and limit each search to the spellings used in that language.
export const CURRENTS_TERMS:Record<string,string[]>={
 en:['Lukashenko','Lukashenka'],ru:['Лукашенко','Лукашэнка'],uk:['Лукашенко','Лукашенка'],pl:['Łukaszenka','Łukaszenko','Lukaszenka','Lukaszenko'],de:['Lukaschenko','Lukaschenka'],fr:['Loukachenko','Loukachenka'],it:['Lukashenko','Lukashenka'],es:['Lukashenko','Lukashenka'],pt:['Lukashenko','Lukashenka'],tr:['Lukaşenko','Lukashenko'],zh:['卢卡申科','盧卡申科','魯卡申柯'],ja:['ルカシェンコ'],ko:['루카셴코'],ar:['لوكاشينكو','لوكاشنكو'],he:['לוקשנקו'],cs:['Lukašenko','Lukašenka'],ro:['Lukașenko','Lukashenko'],nl:['Loekasjenko','Lukashenko'],sv:['Lukasjenko','Lukasjenka'],fi:['Lukashenka','Lukashenko'],hu:['Lukasenka','Lukasenko'],sr:['Лукашенко','Lukašenko'],lt:['Lukašenka','Lukašenkos','Lukašenką'],da:['Lukasjenko','Lukasjenka'],no:['Lukasjenko','Lukasjenka'],el:['Λουκασένκο','Lukashenko'],hi:['लुकाशेंको','Lukashenko'],ur:['لوکاشینکو','لوکاشنکو'],vi:['Lukashenko','Lukashenka'],ca:['Lukaixenko','Lukashenko'],hr:['Lukašenko','Lukašenka'],id:['Lukashenko'],ms:['Lukashenko'],th:['ลูกาเชนโก','Lukashenko'],
};
export const CURRENTS_ARTICLE_LANGUAGES=['en','de','pl','fr','it','es','tr','uk','cs'];
export type CurrentsPlan={language:string;page:number;variant:number;type:1|2};
export type TheNewsPlan={group:number|string;domains:string[];page:number;partition?:string;from_at?:string;to_at?:string;time_depth?:number};
export function currentsPlans(run:Run){
 const languages=[...new Set(run.settings.currents_languages as string[])].filter(code=>DISCOVERY_LANGUAGES[code]?.countries.some(country=>country==='*'||run.settings.countries.includes(country)));
 const articles=CURRENTS_ARTICLE_LANGUAGES.filter(code=>languages.includes(code));
 const plans:CurrentsPlan[]=[];
 // Cover primary languages and the second content class before extra spellings.
 // Every spelling is independent of whether the previous one returned anything.
 for(let variant=0;variant<Math.max(0,...languages.map(code=>CURRENTS_TERMS[code].length));variant++){
  for(const language of languages)if(variant<CURRENTS_TERMS[language].length)plans.push({language,page:1,variant,type:1});
  for(const language of articles)if(variant<CURRENTS_TERMS[language].length)plans.push({language,page:1,variant,type:2});
 }
 return plans.slice(0,Math.max(0,Number(run.settings.currents_per_run)||0));
}
export function thenewsPlans(run:Run,sources:Source[]){
 const groups=batches(sources,40),limit=Number(run.settings.thenews_per_run)||0;
 const offset=groups.length?((Number(run.assistant_number??run.number)-1)*Math.min(limit,groups.length))%groups.length:0;
 return [...groups.slice(offset),...groups.slice(0,offset)].slice(0,limit).map((group,index)=>({group:index,domains:group.map(s=>s.domain),page:1}));
}
export function discoveryJobKey(runId:string,kind:'currents'|'thenews',plan:CurrentsPlan|TheNewsPlan){
 const direction=kind==='currents'?`${(plan as CurrentsPlan).language}:${(plan as CurrentsPlan).type??1}:${(plan as CurrentsPlan).variant??0}`:(plan as TheNewsPlan).partition??`g${(plan as TheNewsPlan).group}`;
 return `${runId}:${kind}:${direction}:${plan.page}`;
}
export function continueDiscovery(provider:string,page:number,maxPages:number,hasMore:boolean,newCandidates:number){
 // The News reports the total hit count: known early pages must not hide its tail.
 return hasMore&&page<maxPages&&(provider==='thenews'||page<2||newCandidates>0);
}
function theNewsWindow(run:Run,payload:TheNewsPlan){
 const from=payload.from_at??run.from_at,to=payload.to_at??run.to_at;
 if(!Number.isFinite(Date.parse(from))||!Number.isFinite(Date.parse(to))||Date.parse(from)<Date.parse(run.from_at)||Date.parse(to)>Date.parse(run.to_at)||Date.parse(from)>=Date.parse(to))throw new Error('invalid_thenews_window');
 return {from_at:new Date(from).toISOString(),to_at:new Date(to).toISOString()};
}
export function thenewsSplitPlans(run:Run,plan:TheNewsPlan,found:{page:number;page_size:number;total_hits:number|null;max_pages:number},sources:Source[]):TheNewsPlan[]{
 if(found.page!==1||!found.total_hits||found.total_hits<=found.page_size*found.max_pages)return [];
 const partition=plan.partition??`g${plan.group}`;
 if(plan.domains.length>10){
  const countries=new Map(sources.map(source=>[source.domain,source.country]));
  const groups=new Map<string,string[]>();
  for(const domain of [...new Set(plan.domains)]){const country=countries.get(domain)||'';groups.set(country,[...(groups.get(country)||[]),domain]);}
  const priority=['US','DE','PL','FR','IT','GB','ES','TR','LT','LV','EE'];
  const rank=(country:string)=>priority.includes(country)?priority.indexOf(country):country==='RU'?1002:country==='UA'?1001:100;
  return [...groups].sort(([a],[b])=>rank(a)-rank(b)||a.localeCompare(b)).flatMap(([,domains])=>batches(domains,10))
   .map((domains,i)=>({...plan,domains,page:1,partition:partition+'.d'+i}));
 }
 // A single prolific source can still fill every page. Bound time subdivision
 // to two levels; adjacent windows share only their boundary, handled by dedupe.
 const window=theNewsWindow(run,plan),from=Date.parse(window.from_at),to=Date.parse(window.to_at),depth=Number(plan.time_depth)||0;
 if(depth>=2||to-from<=2*3600000)return [];
 const middle=new Date(Math.floor((from+to)/2/1000)*1000).toISOString();
 return [{...plan,...window,to_at:middle,page:1,time_depth:depth+1,partition:partition+'.t0'},
  {...plan,...window,from_at:middle,page:1,time_depth:depth+1,partition:partition+'.t1'}];
}
async function pace(rt:Runtime,provider:string){
 const delay=Number(must(await rt.db.rpc('l_news_provider_rate_slot',{p_provider:provider})))||0;
 if(delay>0)await new Promise(resolve=>setTimeout(resolve,delay));
}
export async function searchCurrents(rt:Runtime,job:Job,run:Run){
 const key=rt.secret('CURRENTSAPI_API_KEY');if(!key)throw new Error('currents_key_missing');
 const page=Math.max(1,Math.min(10,Number(job.payload.page)||1)),language=String(job.payload.language);
 const terms=CURRENTS_TERMS[language],variant=Number(job.payload.variant??0),type=Number(job.payload.type??1);
 if(!terms||!Number.isInteger(variant)||variant<0||variant>=terms.length||![1,2].includes(type))throw new Error('invalid_currents_direction');
 const term=terms[variant];
 const usage=await reserve(rt,job,run,'currents','search',page,run.settings.currents_per_run,0);if(!usage)return {capped:true,candidates:[],next:false};
 await pace(rt,'currents');
 const query=new URLSearchParams({keywords:term,language,page_size:'20',page_number:String(page),start_date:run.from_at,end_date:run.to_at,type:String(type)});
 const start=Date.now();let status=0,data:any={},headers=new Headers();
 try{const response=await fetch('https://api.currentsapi.services/v1/search?'+query,{headers:{Authorization:'Bearer '+key},signal:AbortSignal.timeout(25000)});status=response.status;headers=response.headers;data=await response.json().catch(()=>({}));}catch{/* Reserve unknown request outcomes conservatively. */}
 const list=Array.isArray(data.news)?data.news:[];
 must(await rt.db.from('l_news_usage').update({status,credits:1,result_count:list.length,elapsed_ms:Date.now()-start,details:{assistant_id:2,language,page,query:term,variant,type,sample:list.slice(0,3).map((a:any)=>({domain:domainOf(a.url),title:clean(a.title)}))}}).eq('id',usage));
 const remaining=headers.get('x-ratelimit-remaining'),limit=headers.get('x-ratelimit-limit');
 if(remaining!==null&&Number.isFinite(Number(remaining)))await saveState(rt,'currents',{configured:true,limits:{remaining:Number(remaining),limit:Number(limit)||250,resetAt:headers.get('x-ratelimit-reset-time')},source:'last_search_headers'});
 if(status!==200)throw new Error('currents_search_'+status);
 return {candidates:list.map((a:any):Candidate=>({url:String(a.url||''),title:clean(a.title),lead:clean(a.description),body:'',published_at:a.published||null,language,country:'',domain:domainOf(a.url),provider:'currents',provider_id:String(a.id||a.url),image:a.image})),next:list.length===20,page,variant,type,max_pages:Number(run.settings.currents_pages_per_query)||3};
}
export async function searchTheNews(rt:Runtime,job:Job,run:Run){
 const key=rt.secret('THENEWSAPI_API_KEY','THE_NEWS_API_KEY');if(!key)throw new Error('thenews_key_missing');
 const page=Math.max(1,Math.min(10,Number(job.payload.page)||1));
 const window=theNewsWindow(run,job.payload);
 const usage=await reserve(rt,job,run,'thenews','search',page,run.settings.thenews_per_run,0);if(!usage)return {capped:true,candidates:[],next:false};
 await pace(rt,'thenews');
 const query=new URLSearchParams({api_token:key,search:[...new Set(NAMES)].map(name=>'"'+name+'"').join(' | '),search_fields:'title,description,main_text',domains:(job.payload.domains as string[]).join(','),published_after:window.from_at.slice(0,19),published_before:window.to_at.slice(0,19),sort:'published_at',limit:'3',page:String(page)});
 const start=Date.now();let status=0,data:any={},headers=new Headers();
 try{const response=await fetch('https://api.thenewsapi.com/v1/news/all?'+query,{signal:AbortSignal.timeout(25000)});status=response.status;headers=response.headers;data=await response.json().catch(()=>({}));}catch{/* Never log the URL: the provider requires a query-string token. */}
 const list=Array.isArray(data.data)?data.data:[];
 must(await rt.db.from('l_news_usage').update({status,credits:1,result_count:list.length,elapsed_ms:Date.now()-start,details:{assistant_id:2,group:job.payload.group,partition:job.payload.partition??null,domains_count:job.payload.domains.length,...window,page,total_hits:data.meta?.found??null}}).eq('id',usage));
 const remaining=headers.get('x-usagelimit-remaining'),limit=headers.get('x-usagelimit-limit');
 if(remaining!==null&&Number.isFinite(Number(remaining)))await saveState(rt,'thenews',{configured:true,limits:{remaining:Number(remaining),limit:Number(limit)||100,resetAt:new Date(Date.UTC(new Date().getUTCFullYear(),new Date().getUTCMonth(),new Date().getUTCDate()+1)).toISOString()},source:'last_search_headers'});
 if(status!==200)throw new Error('thenews_search_'+status);
 const size=Number(data.meta?.limit)||3;
 const total=data.meta?.found==null?null:Number(data.meta.found);
 return {candidates:list.map((a:any):Candidate=>({url:String(a.url||''),title:clean(a.title),lead:clean(a.snippet||a.description),body:String(a.main_text||a.content||''),content_truncated:true,published_at:a.published_at||null,language:a.language||'',country:'',domain:domainOf(a.url),provider:'thenews',provider_id:String(a.uuid||a.url),image:a.image_url})),next:list.length===size&&(total===null||page*size<total),page,page_size:size,total_hits:total,max_pages:Number(run.settings.thenews_pages_per_query)||8};
}
