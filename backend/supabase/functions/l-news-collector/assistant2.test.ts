import {cloroCandidates,cloroCountries,currentsPlans,pollCloro,submitCloro,validateAssistant2Settings} from './assistant2.ts';
import {CLORO_DEFAULT_COUNTRIES,CLORO_PRIORITY,CLORO_ROTATION,CLORO_PROFILES,cloroRequest,cloroSearchMetadata} from './cloro-config.ts';
import {containsName} from './core.ts';
import {reserve} from './providers.ts';
import type {Job,Run,Runtime} from './providers.ts';
const equal=(actual:unknown,expected:unknown)=>{if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);};
const run={id:'r2',assistant_id:2,assistant_number:1,from_at:'2026-11-25T00:00:00Z',to_at:'2026-11-26T02:00:00Z',settings:{countries:CLORO_DEFAULT_COUNTRIES,cloro_countries:CLORO_DEFAULT_COUNTRIES,cloro_per_run:4,currents_languages:['de'],currents_per_run:4}} as Run;
const job={id:73,run_id:'r2',kind:'cloro',payload:{country:'DE'},attempts:1} as Job;
Deno.test('Cloro fixes US/DE/PL and cycles all nine other countries within the four-query budget',()=>{
 const actual=Array.from({length:18},(_,i)=>cloroCountries({...run,assistant_number:i+1}));
 for(let i=0;i<actual.length;i++)equal(actual[i],[...CLORO_PRIORITY,CLORO_ROTATION[i%9]]);
 equal(cloroCountries({...run,settings:{...run.settings,countries:['IT','DE']}}),['DE','IT']);
 equal(cloroCountries({...run,settings:{...run.settings,cloro_per_run:0}}),[]);
 equal(cloroCountries({...run,settings:{...run.settings,cloro_per_run:2}}),['US','DE']);
 equal(currentsPlans(run),[{language:'de',page:1}]);
 equal(currentsPlans({...run,settings:{...run.settings,countries:['IT']}}),[]);
});
Deno.test('a changed rotation starts with France at the next assistant number',()=>{
 const anchored={...run,settings:{...run.settings,cloro_rotation_start:3}};
 equal(cloroCountries({...anchored,assistant_number:3}),['US','DE','PL','FR']);
 equal(cloroCountries({...anchored,assistant_number:4}),['US','DE','PL','IT']);
 equal(cloroCountries({...anchored,assistant_number:5}),['US','DE','PL','UA']);
 equal(cloroCountries({...anchored,assistant_number:6}),['US','DE','PL','GB']);
});
Deno.test('only explicitly localized countries can be selected or scheduled',()=>{
 const metadata=cloroSearchMetadata();equal(metadata.priority_countries,['US','DE','PL']);
 for(const country of CLORO_DEFAULT_COUNTRIES)equal(metadata.countries.includes(country),true);
 equal(metadata.countries.includes('MM'),false);
 const scoped={...run,settings:{...run.settings,countries:['DE','MM'],cloro_countries:['DE','MM']}};
 equal(cloroCountries(scoped),['DE']);
 let error='';try{validateAssistant2Settings({cloro_countries:['MM']},['DE','MM']);}catch(e){error=String(e);}
 equal(error.includes('invalid_cloro_countries'),true);
 equal(validateAssistant2Settings({cloro_countries:['LT','LV','EE','ES','TR']},['LT','LV','EE','ES','TR']).cloro_countries,['LT','LV','EE','ES','TR']);
});
Deno.test('every advertised locale builds a local request with the same single-page charge',()=>{
 for(const [country,profile] of Object.entries(CLORO_PROFILES)){
  const payload=cloroRequest(country,run.from_at,run.to_at);
  equal(payload.country,country);equal(payload.gl,country.toLowerCase());equal(payload.hl,profile.language);equal(payload.pages,1);
  for(const term of profile.terms){equal(payload.query.includes(term),true);if(!containsName(term))throw new Error('Missing relevance alias: '+country+' '+term);}
  equal(payload.query.endsWith('after:2026-11-24 before:2026-11-27'),true);
 }
 for(const [country,language,term] of [['LT','lt','Lukašenką'],['LV','lv','Lukašenko'],['EE','et','Lukašenka'],['CZ','cs','Lukašenko'],['SK','sk','Lukašenko'],['HU','hu','Lukasenka'],['RO','ro','Lukașenko'],['BG','bg','Лукашенко'],['RS','sr','Лукашенко'],['KZ','ru','Лукашенко'],['KG','ru','Лукашенко'],['QA','ar','لوكاشينكو']]){
  const payload=cloroRequest(country,run.from_at,run.to_at);equal(payload.hl,language);equal(payload.query.includes(term),true);
 }
});
Deno.test('unsupported locales cannot reserve credits or submit a request',async()=>{
 let reservations=0;const rt={secret:()=> 'fixture',db:{rpc:()=>{reservations++;return {data:77};}}} as Runtime;
 let error='';try{await submitCloro(rt,{...job,payload:{country:'MM'}},run);}catch(e){error=String(e);}
 equal(error.includes('invalid_cloro_country'),true);equal(reservations,0);
});
Deno.test('Cloro relative dates never establish publication freshness',()=>{
 const rows=cloroCandidates({response:{newsResults:[{link:'https://www.quotidiano.net/news/example',title:'Lukashenko',date:'2 hours ago',snippet:'Interview'}]}},'IT');
 equal(rows.length,1);equal(rows[0].published_at,null);equal(rows[0].language,'it');equal(rows[0].provider,'cloro');
});
Deno.test('settings reject malformed quotas and arbitrary language/country inputs',()=>{
 for(const patch of [{cloro_daily_credits:-1},{newscatcher_per_run:1.3},{cloro_enabled:'true'},{local_time:'25:00'},{countries:[]},{countries:['XX']},{currents_languages:['xx']}]){
  let failed=false;try{validateAssistant2Settings(patch,['IT','DE']);}catch{failed=true;}equal(failed,true);
 }
 const patch=validateAssistant2Settings({countries:['IT','IT'],currents_languages:['de'],cloro_per_run:0,service_role_key:'never'},['IT','DE']);
 equal(patch.countries,['IT']);equal(patch.cloro_per_run,0);equal(patch.service_role_key,undefined);
});
Deno.test('only helper 2 search providers use its budget; helper 1 and shared extraction keep legacy budgets',async()=>{
 const calls:string[]=[];const rt={db:{rpc:(name:string)=>{calls.push(name);return {data:1};}}} as Runtime;
 await reserve(rt,job,run,'cloro','search',1,4,0);
 await reserve(rt,job,{...run,assistant_id:1},'newscatcher','search',1,32,1800);
 await reserve(rt,job,run,'webscrapingai','extract',1,4,120);
 equal(calls,['l_news_reserve_assistant2_call','l_news_reserve_call','l_news_reserve_call']);
});
Deno.test('Cloro timeout retry reuses its idempotency key; polling does not reserve a second charge',async()=>{
 const original=globalThis.fetch;const requests:any[]=[];let reservations=0;const updates:any[]=[];
 const rt={secret:()=> 'fixture',db:{rpc:()=>{reservations++;return {data:77};},from:()=>({update:(patch:any)=>({eq:()=>{updates.push(patch);return {data:null};}})})}} as Runtime;
 const task='eaed394d-5d7d-48fc-9d21-ad75b84c1d9c';let phase=0;
 globalThis.fetch=async (_url,options)=>{
  if(options?.method==='POST'){requests.push(JSON.parse(String(options.body)));if(phase++===0)throw new Error('timeout');return Response.json({task:{id:task}});}
  return Response.json({task:{status:'COMPLETED'},response:{newsResults:[]},credits:{creditsCharged:3}});
 };
 try{
  let failed=false;try{await submitCloro(rt,job,run);}catch{failed=true;}equal(failed,true);equal(updates[0].credits,3);
  const payload=await submitCloro(rt,job,run);equal(requests[0].idempotencyKey,requests[1].idempotencyKey);
  equal(requests[0].payload.pages,1);equal(requests[0].payload.hl,'de');
  await pollCloro(rt,{...job,payload});equal(reservations,2);equal(updates.at(-1).credits,3);
 }finally{globalThis.fetch=original;}
});

Deno.test('Cloro keeps its budget reservation across 429 retries and settles a final rejection',async()=>{
 const original=globalThis.fetch;const updates:any[]=[];
 const rt={secret:()=> 'fixture',db:{rpc:()=>({data:77}),from:()=>({update:(patch:any)=>({eq:()=>{updates.push(patch);return {data:null};}})})}} as Runtime;
 globalThis.fetch=async ()=>Response.json({error:'rate_limit'},{status:429});
 try{
  for(const attempts of [1,4])try{await submitCloro(rt,{...job,attempts},run);}catch{/* Expected provider rejection. */}
  equal(updates.map(row=>row.credits),[3,0]);
 }finally{globalThis.fetch=original;}
});
