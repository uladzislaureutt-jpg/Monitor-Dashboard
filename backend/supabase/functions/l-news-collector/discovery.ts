import {Candidate,NAMES,Source,batches,clean,domainOf} from './core.ts';
import {Job,Run,Runtime,must,reserve,saveState} from './providers.ts';

// All 34 provider-supported codes; enabled defaults cover our current catalog.
export const DISCOVERY_LANGUAGES:Record<string,{label:string;countries:string[]}>= {
 en:{label:'Английский',countries:['*']},ru:{label:'Русский',countries:['RU','UA','KZ','KG','GE','AM','LT','LV','EE','PL','DE','GB','US','CA']},uk:{label:'Украинский',countries:['UA']},pl:{label:'Польский',countries:['PL']},de:{label:'Немецкий',countries:['DE','AT','CH']},fr:{label:'Французский',countries:['FR','BE','CH','CA','MA','DZ']},it:{label:'Итальянский',countries:['IT','CH','VA']},es:{label:'Испанский',countries:['ES','MX','CU','US','GQ']},pt:{label:'Португальский',countries:['PT','BR']},tr:{label:'Турецкий',countries:['TR']},zh:{label:'Китайский',countries:['CN','TW']},ja:{label:'Японский',countries:['JP']},ko:{label:'Корейский',countries:['KR']},ar:{label:'Арабский',countries:['QA','AE','SA','OM','JO','EG','DZ','MA','LY','LB']},he:{label:'Иврит',countries:['IL']},cs:{label:'Чешский',countries:['CZ']},ro:{label:'Румынский',countries:['RO','MD']},nl:{label:'Нидерландский',countries:['NL','BE']},sv:{label:'Шведский',countries:['SE','FI']},fi:{label:'Финский',countries:['FI']},hu:{label:'Венгерский',countries:['HU']},sr:{label:'Сербский',countries:['RS']},lt:{label:'Литовский',countries:['LT']},da:{label:'Датский',countries:['DK']},no:{label:'Норвежский',countries:['NO']},el:{label:'Греческий',countries:['GR']},hi:{label:'Хинди',countries:['IN']},ur:{label:'Урду',countries:['PK']},vi:{label:'Вьетнамский',countries:['VN']},ca:{label:'Каталанский',countries:['ES']},hr:{label:'Хорватский',countries:['HR']},id:{label:'Индонезийский',countries:['ID']},ms:{label:'Малайский',countries:['MY']},th:{label:'Тайский',countries:['TH']},
};
// Keep stemming and limit each search to the spellings used in that language.
export const CURRENTS_TERMS:Record<string,string[]>={
 en:['Lukashenko','Lukashenka'],ru:['Лукашенко','Лукашэнка'],uk:['Лукашенко','Лукашенка'],pl:['Łukaszenka','Lukaszenka','Lukaszenko'],de:['Lukaschenko','Lukaschenka'],fr:['Loukachenko','Loukachenka'],it:['Lukashenko','Lukashenka'],es:['Lukashenko','Lukashenka'],pt:['Lukashenko','Lukashenka'],tr:['Lukaşenko','Lukashenko'],zh:['卢卡申科','盧卡申科','魯卡申柯'],ja:['ルカシェンコ'],ko:['루카셴코'],ar:['لوكاشينكو'],he:['לוקשנקו'],cs:['Lukašenko','Lukašenka'],ro:['Lukașenko','Lukashenko'],nl:['Loekasjenko','Lukashenko'],sv:['Lukasjenko','Lukasjenka'],fi:['Lukashenka','Lukashenko'],hu:['Lukasenka','Lukasenko'],sr:['Лукашенко','Lukašenko'],lt:['Lukašenka','Lukašenkos'],da:['Lukasjenko','Lukasjenka'],no:['Lukasjenko','Lukasjenka'],el:['Λουκασένκο','Lukashenko'],hi:['लुकाशेंको','Lukashenko'],ur:['لوکاشینکو','لوکاشنکو'],vi:['Lukashenko','Lukashenka'],ca:['Lukaixenko','Lukashenko'],hr:['Lukašenko','Lukašenka'],id:['Lukashenko'],ms:['Lukashenko'],th:['ลูกาเชนโก','Lukashenko'],
};
export function currentsPlans(run:Run){
 return (run.settings.currents_languages as string[]).filter(code=>DISCOVERY_LANGUAGES[code]?.countries.some(country=>country==='*'||run.settings.countries.includes(country)))
  .slice(0,Number(run.settings.currents_per_run)||0).map(language=>({language,page:1}));
}
export function thenewsPlans(run:Run,sources:Source[]){
 const groups=batches(sources,40),limit=Number(run.settings.thenews_per_run)||0;
 const offset=groups.length?((Number(run.assistant_number??run.number)-1)*Math.min(limit,groups.length))%groups.length:0;
 return [...groups.slice(offset),...groups.slice(0,offset)].slice(0,limit).map((group,index)=>({group:index,domains:group.map(s=>s.domain),page:1}));
}
export function continueDiscovery(page:number,maxPages:number,fullPage:boolean,newCandidates:number){
 // A second full page checks below already-known headlines. Beyond it, only
 // extend directions that still supply new candidates to the shared index.
 return fullPage&&page<maxPages&&(page<2||newCandidates>0);
}
async function pace(rt:Runtime,provider:string){
 const delay=Number(must(await rt.db.rpc('l_news_provider_rate_slot',{p_provider:provider})))||0;
 if(delay>0)await new Promise(resolve=>setTimeout(resolve,delay));
}
export async function searchCurrents(rt:Runtime,job:Job,run:Run){
 const key=rt.secret('CURRENTSAPI_API_KEY');if(!key)throw new Error('currents_key_missing');
 const page=Math.max(1,Math.min(10,Number(job.payload.page)||1)),language=String(job.payload.language);
 const usage=await reserve(rt,job,run,'currents','search',page,run.settings.currents_per_run,0);if(!usage)return {capped:true,candidates:[],next:false};
 await pace(rt,'currents');
 const terms=CURRENTS_TERMS[language]||CURRENTS_TERMS.en,variant=Math.max(0,Math.min(terms.length-1,Number(job.payload.variant)||0)),term=terms[variant];
 const query=new URLSearchParams({keywords:term,language,page_size:'20',page_number:String(page),start_date:run.from_at,end_date:run.to_at,type:'1'});
 const start=Date.now();let status=0,data:any={},headers=new Headers();
 try{const response=await fetch('https://api.currentsapi.services/v1/search?'+query,{headers:{Authorization:'Bearer '+key},signal:AbortSignal.timeout(25000)});status=response.status;headers=response.headers;data=await response.json().catch(()=>({}));}catch{/* Reserve unknown request outcomes conservatively. */}
 const list=Array.isArray(data.news)?data.news:[];
 must(await rt.db.from('l_news_usage').update({status,credits:1,result_count:list.length,elapsed_ms:Date.now()-start,details:{assistant_id:2,language,page,query:term,variant,sample:list.slice(0,3).map((a:any)=>({domain:domainOf(a.url),title:clean(a.title)}))}}).eq('id',usage));
 const remaining=headers.get('x-ratelimit-remaining'),limit=headers.get('x-ratelimit-limit');
 if(remaining!==null&&Number.isFinite(Number(remaining)))await saveState(rt,'currents',{configured:true,limits:{remaining:Number(remaining),limit:Number(limit)||250,resetAt:headers.get('x-ratelimit-reset-time')},source:'last_search_headers'});
 if(status!==200)throw new Error('currents_search_'+status);
 return {candidates:list.map((a:any):Candidate=>({url:String(a.url||''),title:clean(a.title),lead:clean(a.description),body:'',published_at:a.published||null,language,country:'',domain:domainOf(a.url),provider:'currents',provider_id:String(a.id||a.url),image:a.image})),next:list.length===20,page,variant,next_variant:page===1&&variant+1<terms.length&&(list.length===0||language==='zh')?variant+1:null,max_pages:Number(run.settings.currents_pages_per_query)||3};
}
export async function searchTheNews(rt:Runtime,job:Job,run:Run){
 const key=rt.secret('THENEWSAPI_API_KEY','THE_NEWS_API_KEY');if(!key)throw new Error('thenews_key_missing');
 const page=Math.max(1,Math.min(10,Number(job.payload.page)||1));
 const usage=await reserve(rt,job,run,'thenews','search',page,run.settings.thenews_per_run,0);if(!usage)return {capped:true,candidates:[],next:false};
 await pace(rt,'thenews');
 const query=new URLSearchParams({api_token:key,search:[...new Set(NAMES)].map(name=>'"'+name+'"').join(' | '),search_fields:'title,description,main_text',domains:(job.payload.domains as string[]).join(','),published_after:new Date(run.from_at).toISOString().slice(0,19),published_before:new Date(run.to_at).toISOString().slice(0,19),sort:'published_at',limit:'3',page:String(page)});
 const start=Date.now();let status=0,data:any={},headers=new Headers();
 try{const response=await fetch('https://api.thenewsapi.com/v1/news/all?'+query,{signal:AbortSignal.timeout(25000)});status=response.status;headers=response.headers;data=await response.json().catch(()=>({}));}catch{/* Never log the URL: the provider requires a query-string token. */}
 const list=Array.isArray(data.data)?data.data:[];
 must(await rt.db.from('l_news_usage').update({status,credits:1,result_count:list.length,elapsed_ms:Date.now()-start,details:{assistant_id:2,group:job.payload.group,page,total_hits:data.meta?.found??null}}).eq('id',usage));
 const remaining=headers.get('x-usagelimit-remaining'),limit=headers.get('x-usagelimit-limit');
 if(remaining!==null&&Number.isFinite(Number(remaining)))await saveState(rt,'thenews',{configured:true,limits:{remaining:Number(remaining),limit:Number(limit)||100,resetAt:new Date(Date.UTC(new Date().getUTCFullYear(),new Date().getUTCMonth(),new Date().getUTCDate()+1)).toISOString()},source:'last_search_headers'});
 if(status!==200)throw new Error('thenews_search_'+status);
 const size=Number(data.meta?.limit)||3;
 return {candidates:list.map((a:any):Candidate=>({url:String(a.url||''),title:clean(a.title),lead:clean(a.snippet||a.description),body:String(a.main_text||a.content||''),content_truncated:true,published_at:a.published_at||null,language:a.language||'',country:'',domain:domainOf(a.url),provider:'thenews',provider_id:String(a.uuid||a.url),image:a.image_url})),next:list.length===size&&page*size<Number(data.meta?.found||0),page,max_pages:Number(run.settings.thenews_pages_per_query)||3};
}
