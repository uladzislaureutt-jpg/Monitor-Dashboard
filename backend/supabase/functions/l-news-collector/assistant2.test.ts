import {cloroCandidates,cloroCountries,currentsPlans,pollCloro,submitCloro,validateAssistant2Settings} from './assistant2.ts';
import {reserve} from './providers.ts';
import type {Job,Run,Runtime} from './providers.ts';
const equal=(actual:unknown,expected:unknown)=>{if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);};
const run={id:'r2',assistant_id:2,assistant_number:1,from_at:'2026-11-25T00:00:00Z',to_at:'2026-11-26T02:00:00Z',settings:{countries:['PL','UA','RU','DE','IT'],cloro_countries:['PL','UA','RU','DE','IT'],cloro_per_run:4,currents_languages:['de'],currents_per_run:4}} as Run;
const job={id:73,run_id:'r2',kind:'cloro',payload:{country:'DE'},attempts:1} as Job;
Deno.test('Cloro rotates extra countries, Currents only searches selected languages and scope',()=>{
 equal(cloroCountries(run),['PL','UA','RU','DE']);
 equal(cloroCountries({...run,assistant_number:2}),['PL','UA','RU','IT']);
 equal(cloroCountries({...run,settings:{...run.settings,countries:['IT','DE']}}),['DE','IT']);
 equal(currentsPlans(run),[{language:'de',page:1}]);
 equal(currentsPlans({...run,settings:{...run.settings,countries:['IT']}}),[]);
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
